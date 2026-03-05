const { createApp, ref, reactive, computed } = Vue

var ColumnRow = {
  props: ['column'],
  setup() {
    const count = ref(0)
    return { count }
  },
  template: `
    <div class="mb-2">
      <input v-model="column.name">
    </div>`
}

function getQueryParams() {
  const params = {};
  const queryString = window.location.search.substring(1);
  const pairs = queryString.split('&').filter(Boolean);
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    params[decodeURIComponent(key)] = decodeURIComponent(value || '');
  }
  return params;
}

const app = createApp({
  components: { ColumnRow: ColumnRow },
  methods: {
    async importDataFromFile(event) {
      this.input.file = event.target.files[0]
      document.title = `${this.input.file.name} - ${this.appMetadata.name}`
      await Parser.parseFile(this.input.file, (d) => this.input.dataset = d)
    },
    async importDataFromService(event) {
      this.input.file = event.target.files[0]
      document.title = `${this.input.file.name} - ${this.appMetadata.name}`
      // TODO: call service and get the metadata
      await OpenCPU.parseFile(this.input.file, (d) => this.input.dataset = d)
    },
    async importMetadata(event) {
      if (this.input.file === null) {
        console.log('Data file must already exist!');
      } else {
        //this.meta.file = event.target.files[0]
        this.input.dataset.columns = importDdiCMetadata(event.target.files[0], this.input.dataset.columns)
      }
    },
    async importCdifMetadata(event) {
      // CDIF inventory import doesn't strictly require a data file yet, but we'll follow the same pattern
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const inventory = JSON.parse(e.target.result);
          // Helper to map and update
          const newCols = inventory.map((item, index) => {
            const col = new DatasetColumn(item.variable_name || `Var_${index}`);
            col.position = index;
            col.label = item.variable_name;
            col.variable_definition = item.variable_definition || "";
            col.description = item.value_description || "";

            if (item.variable_type === "Quantitative") {
              col.hasIntendedDataType = RepresentationTypes.find(e => e.id === "Decimal") || RepresentationTypes[0];
            } else if (item.variable_type === "Temporal") {
              col.hasIntendedDataType = RepresentationTypes.find(e => e.id === "DateTime") || RepresentationTypes[0];
            } else {
              col.hasIntendedDataType = RepresentationTypes.find(e => e.id === "String") || RepresentationTypes[0];
            }

            if (item.unit_scale) {
              col.description += ` [Unit/Scale: ${item.unit_scale}]`;
            }
            return col;
          });
          this.input.dataset.columns = newCols;
          this.input.dataset.fileName = event.target.files[0].name; // Set a filename if none exists
        } catch (err) {
          console.error("Failed to parse CDIF Inventory JSON:", err);
          alert("Error importing CDIF Inventory: " + err.message);
        }
      };
      reader.readAsText(event.target.files[0]);
    },
    extractColumnsFromJsonLd(jsonLdData) {
      const columns = []

      // Helper function to extract value from JSON-LD property
      const extractValue = (property) => {
        if (!property) return null
        if (Array.isArray(property)) {
          const firstItem = property[0]
          if (firstItem && typeof firstItem === 'object' && '@value' in firstItem) {
            return firstItem['@value']
          }
          return firstItem || null
        }
        if (typeof property === 'object' && property !== null && '@value' in property) {
          return property['@value']
        }
        return property || null
      }

      // Helper function to get property from node
      const getProperty = (node, propName) => {
        if (!node || typeof node !== 'object') return null
        const baseName = propName.includes(':') ? propName.split(':').pop() : propName
        const variations = [
          `http://schema.org/${baseName}`,
          `http://www.w3.org/2004/02/skos/core#${baseName}`,
          propName,
          `schema:${baseName}`,
          baseName
        ]
        for (const variation of variations) {
          if (variation in node || node.hasOwnProperty(variation) || node[variation] !== undefined) {
            const value = node[variation]
            if (value !== undefined && value !== null) {
              return value
            }
          }
        }
        return null
      }

      // Helper function to find node by @id
      const findNodeById = (nodeId) => {
        if (!nodeId) return null
        const searchArrays = [
          jsonLdData['@graph'],
          jsonLdData['CDIGenerated']
        ]
        for (const arr of searchArrays) {
          if (Array.isArray(arr)) {
            const found = arr.find(n => n['@id'] === nodeId)
            if (found) return found
          }
        }
        return null
      }

      // Collect variables from multiple sources
      const variableMap = new Map() // Map to track variables by name to avoid duplicates

      // Source 1: Extract from Column label node
      const columnLabelNode = findNodeById('https://ddi-cdi.org/label/Column')
      if (columnLabelNode) {
        const columnLabelKeys = Object.keys(columnLabelNode).filter(key =>
          key.startsWith('https://ddi-cdi.org/label/') &&
          key !== 'https://ddi-cdi.org/label/Column'
        )

        // Sort column keys to maintain order
        columnLabelKeys.sort((a, b) => {
          const numA = parseInt(a.split('/').pop()) || 0
          const numB = parseInt(b.split('/').pop()) || 0
          return numA - numB
        })

        console.log('Found column label keys:', columnLabelKeys)

        // Process each column from label system
        columnLabelKeys.forEach((labelKey, index) => {
          const columnRefs = columnLabelNode[labelKey]
          if (!columnRefs) return

          const refArray = Array.isArray(columnRefs) ? columnRefs : [columnRefs]
          const firstRef = refArray[0]
          const refId = firstRef?.['@id'] || (typeof firstRef === 'string' ? firstRef : null)

          if (!refId) return

          const defNode = findNodeById(refId)
          if (!defNode) return

          const definition = getProperty(defNode, 'definition')
          const defValue = extractValue(definition)

          // Parse the definition to extract name and label
          let columnName = defValue || `Column${index + 1}`
          let columnLabel = columnName

          if (defValue && defValue.includes(' ')) {
            const parts = defValue.split(' ')
            columnName = parts[0]
            columnLabel = defValue
          } else {
            columnName = defValue
            columnLabel = defValue
          }

          // Store in map with position
          if (columnName && !variableMap.has(columnName)) {
            variableMap.set(columnName, {
              name: columnName,
              label: columnLabel,
              description: defValue || '',
              position: index,
              source: 'label'
            })
          }
        })
      }

      // Source 2: Extract from xdiCdifMapping for additional variables
      // Priority list of common data column variables (based on XAS data structure)
      const priorityVariables = ['energy', 'i0', 'itrans', 'mutrans', 'ifluor', 'mufluor', 'irefer', 'murefer',
        'normtrans', 'normfluor', 'normrefer', 'k', 'chi', 'chi_mag', 'chi_pha',
        'chi_re', 'chi_im', 'r', 'angle']

      if (jsonLdData['xdiCdifMapping'] && jsonLdData['xdiCdifMapping']['@graph']) {
        const xdiVariables = []
        jsonLdData['xdiCdifMapping']['@graph'].forEach(item => {
          const xdiDict = item['xdi dictionary']
          if (xdiDict && typeof xdiDict === 'string') {
            // Only include base variable names (not properties like "Beamline.name")
            if (xdiDict && !xdiDict.includes('.') &&
              !['Beamline', 'detector', 'facility', 'scan', 'Sample', 'Element', 'Mono', 'Column', 'variables', 'monochormator'].includes(xdiDict)) {
              xdiVariables.push(xdiDict)
            }
          }
        })

        // Sort by priority - prioritize known data column variables
        xdiVariables.sort((a, b) => {
          const aPriority = priorityVariables.indexOf(a)
          const bPriority = priorityVariables.indexOf(b)
          if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority
          if (aPriority !== -1) return -1
          if (bPriority !== -1) return 1
          return a.localeCompare(b)
        })

        // Add variables that aren't already in the map
        let position = variableMap.size
        xdiVariables.forEach(varName => {
          if (!variableMap.has(varName)) {
            variableMap.set(varName, {
              name: varName,
              label: varName,
              description: '',
              position: position++,
              source: 'xdi'
            })
          }
        })

        console.log('Found variables from xdiCdifMapping:', xdiVariables)
      }

      // Convert map to columns array, maintaining order, but KEEP ONLY label-sourced variables, drop others
      const sortedVariables = Array.from(variableMap.entries()).filter(([varName, varInfo]) => varInfo.source === 'label').sort((a, b) => {
        return a[1].position - b[1].position
      })

      // Create DatasetColumn objects
      sortedVariables.forEach(([varName, varInfo], index) => {
        const column = new DatasetColumn(varInfo.name)
        column.position = index
        column.id = varInfo.name
        column.name = varInfo.name
        column.label = varInfo.label
        column.description = varInfo.description

        // Determine data type
        const nameLower = varInfo.name.toLowerCase()
        const labelLower = varInfo.label.toLowerCase()

        // Check for numeric indicators
        if (labelLower.includes('energy') ||
          labelLower.includes('intensity') ||
          labelLower.includes('count') ||
          labelLower.includes('ev') ||
          nameLower.startsWith('i') && (nameLower.includes('0') || nameLower.includes('trans')) ||
          nameLower.startsWith('mu') ||
          nameLower.startsWith('norm') ||
          nameLower === 'k' ||
          nameLower === 'r' ||
          nameLower.startsWith('chi')) {
          // Likely numeric
          column.hasIntendedDataType = RepresentationTypes.find(e => e.id === 'Decimal') ||
            RepresentationTypes.find(e => e.id === 'Float') ||
            RepresentationTypes.find(e => e.type === 'decimal') ||
            RepresentationTypes[0]
        } else {
          // Default to text/String
          column.hasIntendedDataType = RepresentationTypes.find(e => e.id === 'String') ||
            RepresentationTypes.find(e => e.type === 'string') ||
            RepresentationTypes[0]
        }

        column.coded = false
        columns.push(column)
        console.log(`Extracted column ${index + 1}:`, varInfo.name, varInfo.label, `(${varInfo.source})`)
      })

      return columns
    },
    async fetchResourcemapVariables(params) {
      // Build resourcemap endpoint URL (Dataverse API)
      // Expect datasetid as DOI (URN/doi:*), persistentId wants 'doi:xyz'
      let persistentId = params.datasetid || '';
      // Remove 'doi:' or 'doi:' prefix and re-append for compatibility if needed
      if (persistentId.startsWith('doi:')) {
        persistentId = encodeURIComponent(persistentId);
      }
      const resourcemapUrl = `https://dataverse.dev.codata.org/api/datasets/export?exporter=resourcemap&persistentId=${persistentId}`;
      try {
        const resp = await fetch(resourcemapUrl);
        if (!resp.ok) throw new Error('Failed to load resourcemap: ' + resp.status);
        const resourcemap = await resp.json();

        // Create a map of results by variable name for quick lookup of ollama_remote data
        const resultsMap = new Map();
        if (Array.isArray(resourcemap.results)) {
          resourcemap.results.forEach(result => {
            if (result.name && result.ollama_remote) {
              resultsMap.set(result.name, result.ollama_remote);
            }
          });
          console.log(`Built resultsMap with ${resultsMap.size} entries from resourcemap.results`);
        }

        // Map to DatasetColumns (adjust if DatasetColumn structure changes)
        if (Array.isArray(resourcemap.variables)) {
          return resourcemap.variables.map((v, idx) => {
            const col = new DatasetColumn(v.name || v.label || `Var${idx + 1}`);
            col.position = v.fileOrder || idx;
            col.id = v.id || v.name || v.label || `Var${idx + 1}`;
            col.name = v.name || '';
            col.label = v.label || v.name || '';
            col.definition = '';
            col.description = '';

            // Check for ollama_remote data in results map
            let ollamaData = resultsMap.get(v.name);
            // Try case-insensitive match if exact match fails
            if (!ollamaData && v.name) {
              for (const [key, value] of resultsMap.entries()) {
                if (key.toLowerCase() === v.name.toLowerCase()) {
                  ollamaData = value;
                  console.log(`Found ollama_remote for variable ${v.name} via case-insensitive match with ${key}`);
                  break;
                }
              }
            }
            if (ollamaData && ollamaData.ollama) {
              console.log(`Found ollama_remote for variable ${v.name}`);
              let ollama = ollamaData.ollama;

              // Handle case where ollama is a string containing JSON wrapped in markdown code blocks
              if (typeof ollama === 'string') {
                try {
                  let jsonStr = ollama.trim();

                  // Remove markdown code block markers - handle various formats
                  // Remove opening ```json or ``` (case insensitive, with optional whitespace/newlines)
                  jsonStr = jsonStr.replace(/^```json\s*\n?/i, '');
                  jsonStr = jsonStr.replace(/^```\s*\n?/, '');
                  // Remove closing ``` (with optional leading newline/whitespace)
                  jsonStr = jsonStr.replace(/\n?\s*```\s*$/, '');
                  jsonStr = jsonStr.trim();

                  // Try to find JSON object if there's extra text before/after
                  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
                  if (jsonMatch) {
                    jsonStr = jsonMatch[0];
                  }

                  // Strip JavaScript-style comments (both // and /* */)
                  // Strategy: process line by line to handle // comments more safely
                  const lines = jsonStr.split('\n');
                  const cleanedLines = lines.map(line => {
                    // Remove multi-line comments that span lines (handle separately)
                    let cleaned = line;
                    // Remove /* */ comments on the same line
                    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
                    // Remove // comments, but preserve the line structure
                    // Look for // that's not inside a string (simple heuristic: // after quote or comma)
                    const commentIndex = cleaned.indexOf('//');
                    if (commentIndex !== -1) {
                      // Check if // is likely a comment (not in a string)
                      // Simple check: if there's a quote before //, it might be in a string
                      // But if there's a comma or bracket before //, it's likely a comment
                      const beforeComment = cleaned.substring(0, commentIndex);
                      const quoteCount = (beforeComment.match(/"/g) || []).length;
                      // If even number of quotes before //, we're outside a string
                      if (quoteCount % 2 === 0) {
                        cleaned = cleaned.substring(0, commentIndex).trimEnd();
                      }
                    }
                    return cleaned;
                  });
                  jsonStr = cleanedLines.join('\n');

                  // Remove any remaining /* */ multi-line comments
                  jsonStr = jsonStr.replace(/\/\*[\s\S]*?\*\//g, '');

                  // Clean up any trailing commas before closing brackets/braces (JSON doesn't allow these)
                  jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
                  // Clean up any double commas that might result
                  jsonStr = jsonStr.replace(/,\s*,/g, ',');

                  // Parse the JSON string
                  ollama = JSON.parse(jsonStr);
                  console.log(`Successfully parsed ollama JSON for variable ${v.name}`);
                } catch (parseError) {
                  console.warn(`Failed to parse ollama JSON for variable ${v.name}:`, parseError);
                  console.warn(`Parse error details:`, parseError.message);
                  // If parsing fails, try to extract definition from plain text using regex
                  const defMatch = ollama.match(/"definition"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                  if (defMatch && defMatch[1]) {
                    // Unescape JSON string
                    const def = defMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
                    ollama = { definition: def };
                  } else {
                    // Last resort: use the whole string as definition (truncated)
                    ollama = { definition: ollama.substring(0, 500) };
                  }
                }
              }

              // Extract definition - check multiple possible locations
              let definition = null;
              let units = null;
              let properties = null;

              // Case 1: ollama is an object with nested variable name keys (e.g., ollama.HealthZone.definition)
              if (typeof ollama === 'object' && ollama !== null && !Array.isArray(ollama)) {
                // Check if there's a key matching the variable name
                if (v.name && ollama[v.name] && typeof ollama[v.name] === 'object' && ollama[v.name].definition) {
                  definition = ollama[v.name].definition;
                  units = ollama[v.name].units;
                  properties = ollama[v.name].properties;
                }
                // Check if there's any key with a definition (for cases where key doesn't match variable name)
                else {
                  for (const key in ollama) {
                    if (ollama.hasOwnProperty(key) && typeof ollama[key] === 'object' && ollama[key] !== null && ollama[key].definition) {
                      definition = ollama[key].definition;
                      units = ollama[key].units;
                      properties = ollama[key].properties;
                      break; // Use first match
                    }
                  }
                }
              }

              // Case 2: ollama.variable is an object with definition
              if (!definition && ollama.variable && typeof ollama.variable === 'object' && ollama.variable.definition) {
                definition = ollama.variable.definition;
                units = ollama.variable.units;
                properties = ollama.variable.properties;
              }
              // Case 3: ollama has definition directly (when parsed from string or when variable is just a string name)
              else if (!definition && ollama.definition) {
                definition = ollama.definition;
                units = ollama.units;
                properties = ollama.properties;
              }

              if (definition) {
                col.variable_definition = definition;
                col.description = definition;
              }

              // Extract units - handle various formats
              if (units) {
                let unitsStr = '';
                if (typeof units === 'string') {
                  unitsStr = units;
                } else if (Array.isArray(units)) {
                  // Units as array of objects (e.g., [{symbol: "m", name: "meter"}, ...])
                  unitsStr = units.map(u => {
                    if (typeof u === 'string') return u;
                    if (typeof u === 'object' && u.symbol) return u.symbol;
                    if (typeof u === 'object' && u.name) return u.name;
                    return String(u);
                  }).filter(Boolean).join(', ');
                } else if (typeof units === 'object') {
                  // Units as object (e.g., {coordinates: "...", area: "..."})
                  unitsStr = Object.entries(units)
                    .map(([key, value]) => typeof value === 'string' ? `${key}: ${value}` : `${key}`)
                    .join(', ');
                }
                if (unitsStr) {
                  if (col.description) {
                    col.description += ` (${unitsStr})`;
                  } else {
                    col.description = unitsStr;
                  }
                }
              }

              // Extract properties info
              if (properties) {
                const props = [];
                if (typeof properties === 'object' && !Array.isArray(properties)) {
                  // Properties as object
                  if (properties.type) props.push(`Type: ${properties.type}`);
                  if (properties.scale) props.push(`Scale: ${properties.scale}`);
                  if (properties.dimension) props.push(`Dimension: ${properties.dimension}`);
                } else if (Array.isArray(properties)) {
                  // Properties as array - could be strings or objects
                  properties.forEach(p => {
                    if (typeof p === 'string') {
                      props.push(p);
                    } else if (typeof p === 'object' && p.name) {
                      props.push(p.name);
                    }
                  });
                }
                if (props.length > 0 && col.description) {
                  col.description += ` - ${props.slice(0, 3).join(', ')}`; // Limit to first 3 to avoid too long descriptions
                }
              }
            }

            // Fallback to variableMetadata if no ollama_remote data found
            if (!col.variable_definition && v.variableMetadata && Array.isArray(v.variableMetadata) && v.variableMetadata.length) {
              const defMeta = v.variableMetadata.find(m => m.definition || m.label === 'definition');
              if (defMeta && defMeta.definition) {
                col.variable_definition = defMeta.definition;
                if (!col.description) col.description = defMeta.definition;
              }
            }

            col.hasIntendedDataType = (v.variableFormatType && v.variableFormatType.toLowerCase().includes('char')) ?
              (RepresentationTypes.find(e => e.id === 'String') || RepresentationTypes[0]) :
              (RepresentationTypes.find(e => e.id === 'Decimal') || RepresentationTypes[0]);
            col.coded = false;
            return col;
          });
        }
        return [];
      } catch (err) {
        console.error('Failed to fetch or convert resourcemap variables:', err);
        return [];
      }
    },
    async loadJsonLdFromUrl() {
      const params = getQueryParams();
      let url;
      if (params.fileid && params.siteUrl && params.datasetid && params.datasetversion && params.locale) {
        url = 'https://cdif-4-xas.dev.codata.org/cdi?fileid=' + encodeURIComponent(params.fileid)
          + '&siteUrl=' + encodeURIComponent(params.siteUrl)
          + '&datasetid=' + encodeURIComponent(params.datasetid)
          + '&datasetversion=' + encodeURIComponent(params.datasetversion)
          + '&locale=' + encodeURIComponent(params.locale);
      } else if (params.siteUrl) {
        url = params.siteUrl;
      } else {
        url = 'https://cdif-4-xas.dev.codata.org/cdi?fileid=38&siteUrl=https://dataverse.dev.codata.org&datasetid=doi:10.5072/FK2/4ZSKVU&datasetversion=3.0&locale=en';
      }
      await this.loadJsonLdFromUrl_base(url, params);
    },
    async loadJsonLdFromUrlWithParams(params) {
      let url;
      if (params.fileid && params.siteUrl && params.datasetid && params.datasetversion && params.locale) {
        url = 'https://cdif-4-xas.dev.codata.org/cdi?fileid=' + encodeURIComponent(params.fileid || '')
          + '&siteUrl=' + encodeURIComponent(params.siteUrl || '')
          + '&datasetid=' + encodeURIComponent(params.datasetid || '')
          + '&datasetversion=' + encodeURIComponent(params.datasetversion || '')
          + '&locale=' + encodeURIComponent(params.locale || '');
      } else if (params.siteUrl) {
        url = params.siteUrl;
      } else {
        url = 'https://cdif-4-xas.dev.codata.org/cdi?fileid=38&siteUrl=https://dataverse.dev.codata.org&datasetid=doi:10.5072/FK2/4ZSKVU&datasetversion=3.0&locale=en';
      }
      await this.loadJsonLdFromUrl_base(url, params);
    },
    async loadJsonLdFromUrl_base(url, params) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const responseData = await response.json();

        // Check if this is a CDIF Variable Inventory (array of objects)
        if (Array.isArray(responseData)) {
          const dataset = new Dataset();
          dataset.fileName = url.split('/').pop() || 'inventory.json';
          dataset.studyName = 'CDIF Inventory';
          dataset.columns = responseData.map((item, index) => {
            const col = new DatasetColumn(item.variable_name || `Var_${index}`);
            col.position = index;
            col.label = item.variable_name;
            col.variable_definition = item.variable_definition || "";
            col.description = item.value_description || "";
            if (item.variable_type === "Quantitative") {
              col.hasIntendedDataType = RepresentationTypes.find(e => e.id === "Decimal") || RepresentationTypes[0];
            } else if (item.variable_type === "Temporal") {
              col.hasIntendedDataType = RepresentationTypes.find(e => e.id === "DateTime") || RepresentationTypes[0];
            } else {
              col.hasIntendedDataType = RepresentationTypes.find(e => e.id === "String") || RepresentationTypes[0];
            }
            if (item.unit_scale) {
              col.description += ` [Unit/Scale: ${item.unit_scale}]`;
            }
            return col;
          });
          this.input.dataset = dataset;
          this.input.file = { name: dataset.fileName };
          document.title = `${dataset.fileName} - ${this.appMetadata.name}`;
          return;
        }

        const jsonLdData = responseData;

        // Helper function to extract value from JSON-LD property
        const extractValue = (property) => {
          if (!property) return null;
          if (Array.isArray(property)) {
            const firstItem = property[0];
            if (firstItem && typeof firstItem === 'object' && '@value' in firstItem) {
              return firstItem['@value'];
            }
            return firstItem || null;
          }
          if (typeof property === 'object' && property !== null && '@value' in property) {
            return property['@value'];
          }
          return property || null;
        };

        // Helper function to get property from node
        const getProperty = (node, propName) => {
          if (!node || typeof node !== 'object') return null;
          const baseName = propName.includes(':') ? propName.split(':').pop() : propName;
          const variations = [
            `http://schema.org/${baseName}`,
            propName,
            `schema:${baseName}`,
            baseName
          ];
          for (const variation of variations) {
            if (variation in node || node.hasOwnProperty(variation) || node[variation] !== undefined) {
              const value = node[variation];
              if (value !== undefined && value !== null) {
                return value;
              }
            }
          }
          return null;
        };

        // Helper function to find node by type
        const findNodeByType = (type, searchArray) => {
          if (!searchArray || !Array.isArray(searchArray)) return null;
          return searchArray.find(node => {
            if (!node['@type']) return false;
            const nodeTypes = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
            return nodeTypes.some(t =>
              t === type ||
              t === `http://schema.org/${type.split(':').pop()}` ||
              (typeof t === 'string' && t.includes('Dataset'))
            );
          });
        };

        // Helper function to find dataset node
        const findDatasetNode = () => {
          if (jsonLdData['@graph']) {
            let node = findNodeByType('schema:Dataset', jsonLdData['@graph']) ||
              findNodeByType('http://schema.org/Dataset', jsonLdData['@graph']);
            if (node) return node;
            node = jsonLdData['@graph'].find(n => n['@id'] && typeof n['@id'] === 'string' && n['@id'].includes('doi.org'));
            if (node) return node;
          }
          if (jsonLdData['CDIGenerated'] && Array.isArray(jsonLdData['CDIGenerated'])) {
            let node = findNodeByType('schema:Dataset', jsonLdData['CDIGenerated']) ||
              findNodeByType('http://schema.org/Dataset', jsonLdData['CDIGenerated']);
            if (node) return node;
            node = jsonLdData['CDIGenerated'].find(n => n['@id'] && typeof n['@id'] === 'string' && n['@id'].includes('doi.org'));
            if (node) return node;
          }
          return null;
        };

        const dataset = new Dataset();
        const datasetNode = findDatasetNode();

        if (datasetNode) {
          const findNodeById = (nodeId) => {
            if (!nodeId) return null;
            if (jsonLdData['@graph']) {
              const found = jsonLdData['@graph'].find(n => n['@id'] === nodeId);
              if (found) return found;
            }
            if (jsonLdData['CDIGenerated'] && Array.isArray(jsonLdData['CDIGenerated'])) {
              const found = jsonLdData['CDIGenerated'].find(n => n['@id'] === nodeId);
              if (found) return found;
            }
            return null;
          };

          // Extract file name from distribution
          const distribution = getProperty(datasetNode, 'distribution');
          if (distribution) {
            const distArray = Array.isArray(distribution) ? distribution : [distribution];
            for (const distRef of distArray) {
              const distId = distRef['@id'] || (typeof distRef === 'string' ? distRef : null);
              if (distId) {
                const distData = findNodeById(distId);
                if (distData) {
                  const distName = getProperty(distData, 'name');
                  const fileName = extractValue(distName);
                  if (fileName) {
                    dataset.fileName = fileName;
                    break;
                  }
                }
              }
            }
          }
          if (!dataset.fileName) {
            const name = getProperty(datasetNode, 'name');
            const identifier = getProperty(datasetNode, 'identifier');
            dataset.fileName = extractValue(name) || extractValue(identifier) || 'cdi-json-ld.json';
          }

          // Extract dataset metadata
          const name = getProperty(datasetNode, 'name');
          dataset.studyName = extractValue(name) || 'CDI Dataset';
          const schemaOrgNameValue = getProperty(datasetNode, 'http://schema.org/name');
          dataset.schemaOrgName = extractValue(schemaOrgNameValue) || extractValue(name) || '';

          const description = getProperty(datasetNode, 'description');
          const extractedDescription = extractValue(description);
          dataset.studyDescription = extractedDescription || 'Please describe the content and Method of this study.';

          // Extract publisher/study group
          const publisher = getProperty(datasetNode, 'publisher');
          const provider = getProperty(datasetNode, 'provider');
          const publisherRef = publisher || provider;
          if (publisherRef) {
            const pubArray = Array.isArray(publisherRef) ? publisherRef : [publisherRef];
            const pubId = pubArray[0]?.['@id'] || (typeof pubArray[0] === 'string' ? pubArray[0] : null);
            if (pubId) {
              const pubNode = findNodeById(pubId);
              if (pubNode) {
                const pubName = getProperty(pubNode, 'name');
                dataset.studyGroupName = extractValue(pubName) || '';
              }
            } else {
              dataset.studyGroupName = extractValue(pubArray[0]) || '';
            }
          }
          if (dataset.studyGroupName) {
            const publisher = getProperty(datasetNode, 'publisher');
            if (publisher) {
              const pubArray = Array.isArray(publisher) ? publisher : [publisher];
              const pubId = pubArray[0]?.['@id'] || (typeof pubArray[0] === 'string' ? pubArray[0] : null);
              if (pubId) {
                const pubNode = findNodeById(pubId);
                if (pubNode) {
                  const pubDesc = getProperty(pubNode, 'description');
                  dataset.studyGroupDescription = extractValue(pubDesc) || 'Please describe the structure of this study group.';
                }
              }
            }
            if (!dataset.studyGroupDescription) {
              dataset.studyGroupDescription = 'Please describe the structure of this study group.';
            }
          }
        } else {
          dataset.fileName = 'cdi-json-ld.json';
          dataset.studyName = 'CDI Dataset';
          dataset.studyDescription = 'Please describe the content and Method of this study.';
        }

        dataset.mimeType = 'application/ld+json';
        dataset.inputType = 'json-ld';
        dataset.data = [[]];
        dataset.lastModified = new Date().toISOString();

        // Extract columns from JSON-LD
        dataset.columns = this.extractColumnsFromJsonLd(jsonLdData);
        console.log('Extracted columns from JSON-LD:', dataset.columns ? dataset.columns.length : 0, 'columns');

        // Fallback: If no columns found, fetch from resourcemap
        if (!Array.isArray(dataset.columns) || dataset.columns.length === 0) {
          console.warn('No variables found in main JSON-LD, fetching variables from Dataverse resourcemap...');
          const fallbackParams = params || getQueryParams();
          const resourcemapColumns = await this.fetchResourcemapVariables(fallbackParams);
          if (Array.isArray(resourcemapColumns) && resourcemapColumns.length > 0) {
            dataset.columns = resourcemapColumns;
            console.log('Fetched', dataset.columns.length, 'variables from resourcemap');
          } else {
            console.warn('Resourcemap also returned no variables');
            dataset.columns = [];
          }
        }

        dataset.jsonLdData = jsonLdData;
        dataset.serializedData = JSON.stringify(jsonLdData, null, 2);
        this.input.dataset = dataset;
        this.input.file = { name: dataset.fileName };
        document.title = `${dataset.fileName} - ${this.appMetadata.name}`;
      } catch (error) {
        console.error('Error loading JSON-LD from URL:', error);
        alert('Failed to load JSON-LD from URL: ' + error.message);
      }
    },
    saveFile(content, type, fileName) {
      var fileAsBlob = new Blob([content], { type: type })
      saveFileBrowser(fileName, fileAsBlob)
    },
    copyToClipboard(text) {
      copyTextToClipboard(text)
    }
  },
  mounted() {
    // Parse query params and auto-load if /dataverse detected
    const params = getQueryParams();
    if (window.location.pathname.includes('/dataverse')) {
      this.loadJsonLdFromUrlWithParams(params);
      return;
    }
    // Default behavior:
    this.loadJsonLdFromUrl();
  },
  setup() {
    const codeListVariableIndex = ref(null)
    const input = reactive({
      file: null,
      dataset: new Dataset()
    })
    const cv = {
      representationType: RepresentationTypes
    }
    const appMetadata = computed(() => {
      return JSON.parse(document.head.querySelector('script[type="application/ld+json"]').innerText)
    })
    const output = computed(() => {
      // If JSON-LD was loaded from URL, use it directly; otherwise convert dataset to CDI JSON-LD
      const cdiJsonLd = input.dataset.jsonLdData
        ? JSON.stringify(input.dataset.jsonLdData, null, 2)
        : toDdiCdiJsonLd(input.dataset)

      return {
        filename: input.file?.name?.split('.').slice(0, -1).join('.'),
        markdown: datasetToMarkdown(input.dataset),
        csv: [
          input.dataset.columns.map(e => e.name).join(input.dataset.delimiter),
          ...input.dataset.data.map(e => e.join(input.dataset.delimiter))
        ].join('\n'),
        json: cdiJsonLd,
        cdi_data: cdiJsonLd,
        cdi: (hljs.highlight(cdiJsonLd, { language: "json" }).value),
        ddic_data: toDdiCXml(input.dataset),
        ddic: (hljs.highlight(toDdiCXml(input.dataset), { language: "xml" }).value),
        ddil_data: toDdiLXml(input.dataset),
        ddil: (hljs.highlight(toDdiLXml(input.dataset), { language: "xml" }).value),
        ddi40l_data: toDdi40LJson(input.dataset),
        ddi40l: (hljs.highlight(toDdi40LJson(input.dataset), { language: "json" }).value)
      }
    })
    // Add this to expose GET params
    const endpointParams = getQueryParams();
    return {
      input, cv, appMetadata, output, codeListVariableIndex, endpointParams
    }
  }
}).mount("#app")

/**
 * Pre-build script to extract template schemas from TypeScript files.
 * This bypasses Puppeteer-based dynamic loading and creates static JSON.
 *
 * Usage: node prebuild-templates.mjs
 * Run this after adding or modifying templates.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATES_DIR = path.join(__dirname, 'servers/nextjs/presentation-templates');
const OUTPUT_DIR = path.join(__dirname, 'app_data/template-layouts');

/**
 * Extract content between matching braces/parens starting from a position
 */
function extractBalancedContent(str, startChar = '{', endChar = '}', startFrom = 0) {
    const startIdx = str.indexOf(startChar, startFrom);
    if (startIdx === -1) return null;

    let depth = 0;
    let start = -1;

    for (let i = startIdx; i < str.length; i++) {
        if (str[i] === startChar) {
            if (depth === 0) start = i + 1;
            depth++;
        } else if (str[i] === endChar) {
            depth--;
            if (depth === 0) {
                return { content: str.substring(start, i), endIndex: i };
            }
        }
    }
    return null;
}

/**
 * Normalize multiline z.xxx calls (e.g., "z\n  .object" -> "z.object")
 */
function normalizeZodCalls(content) {
    // Replace patterns like "z\n  ." or "z\n." with "z."
    return content.replace(/z\s*\n\s*\./g, 'z.');
}

/**
 * Extract all named schema definitions from the file content
 * Returns a map of schema name -> parsed schema
 */
function extractNamedSchemas(content) {
    const schemas = {};

    // Normalize first to handle multiline z.xxx calls
    const normalizedContent = normalizeZodCalls(content);

    // Match patterns like: const SomethingSchema = z.object({...}) or z.object({...}).default(...)
    const schemaPattern = /const\s+(\w+)\s*=\s*z\.object\s*\(/g;
    let match;

    while ((match = schemaPattern.exec(normalizedContent)) !== null) {
        const schemaName = match[1];
        const startPos = match.index + match[0].length;

        // Extract the balanced content of z.object({...})
        const extracted = extractBalancedContent(normalizedContent, '{', '}', startPos - 1);
        if (extracted) {
            schemas[schemaName] = extracted.content;
        }
    }

    return schemas;
}

/**
 * Parse a .merge() chain and return combined schema content
 * Handles: BaseSchema.merge(z.object({...})) or Schema1.merge(Schema2)
 */
function parseMergeChain(mergeExpr, namedSchemas) {
    const result = {};

    // Pattern: SomeName.merge(...) or z.object({...}).merge(...)
    // We need to find the base and what's being merged

    // First, check if it starts with a named schema reference
    const namedBaseMatch = mergeExpr.match(/^(\w+)\.merge\(/);
    if (namedBaseMatch) {
        const baseName = namedBaseMatch[1];
        if (namedSchemas[baseName]) {
            // Parse the base schema
            const baseFields = parseObjectContent(namedSchemas[baseName], namedSchemas);
            Object.assign(result, baseFields);
        }

        // Now parse what's inside .merge(...)
        const mergeStart = mergeExpr.indexOf('.merge(') + 7;
        const mergeContent = extractBalancedContent(mergeExpr, '(', ')', mergeStart - 1);
        if (mergeContent) {
            const innerContent = mergeContent.content.trim();

            // Check if it's z.object({...})
            if (innerContent.startsWith('z.object(')) {
                const objStart = innerContent.indexOf('z.object(') + 9;
                const objContent = extractBalancedContent(innerContent, '{', '}', objStart);
                if (objContent) {
                    const mergedFields = parseObjectContent(objContent.content, namedSchemas);
                    Object.assign(result, mergedFields);
                }
            }
            // Check if it's another named schema
            else {
                const innerSchemaMatch = innerContent.match(/^(\w+)/);
                if (innerSchemaMatch && namedSchemas[innerSchemaMatch[1]]) {
                    const mergedFields = parseObjectContent(namedSchemas[innerSchemaMatch[1]], namedSchemas);
                    Object.assign(result, mergedFields);
                }
            }

            // Check for chained .merge() calls
            const remainingContent = mergeExpr.substring(mergeStart + mergeContent.endIndex);
            if (remainingContent.includes('.merge(')) {
                const chainedMergeMatch = remainingContent.match(/\.merge\(/);
                if (chainedMergeMatch) {
                    // Recursively handle chained merges
                    const chainedFields = parseMergeChain(remainingContent.substring(1), namedSchemas);
                    Object.assign(result, chainedFields);
                }
            }
        }
    }
    // Check if it starts with z.object({...}).merge(...)
    else if (mergeExpr.startsWith('z.object(')) {
        const objStart = 9;
        const objContent = extractBalancedContent(mergeExpr, '{', '}', objStart);
        if (objContent) {
            const baseFields = parseObjectContent(objContent.content, namedSchemas);
            Object.assign(result, baseFields);

            // Find and parse the .merge() part
            const afterBase = mergeExpr.substring(objContent.endIndex + 1);
            const mergeMatch = afterBase.match(/^\s*\)\s*\.merge\(/);
            if (mergeMatch) {
                const mergeStart = afterBase.indexOf('.merge(') + 7;
                const mergeContent = extractBalancedContent(afterBase, '(', ')', mergeStart - 1);
                if (mergeContent) {
                    const innerContent = mergeContent.content.trim();

                    if (innerContent.startsWith('z.object(')) {
                        const innerObjStart = innerContent.indexOf('z.object(') + 9;
                        const innerObjContent = extractBalancedContent(innerContent, '{', '}', innerObjStart);
                        if (innerObjContent) {
                            const mergedFields = parseObjectContent(innerObjContent.content, namedSchemas);
                            Object.assign(result, mergedFields);
                        }
                    } else {
                        const innerSchemaMatch = innerContent.match(/^(\w+)/);
                        if (innerSchemaMatch && namedSchemas[innerSchemaMatch[1]]) {
                            const mergedFields = parseObjectContent(namedSchemas[innerSchemaMatch[1]], namedSchemas);
                            Object.assign(result, mergedFields);
                        }
                    }
                }
            }
        }
    }

    return result;
}

/**
 * Extract Zod schema fields from TypeScript code.
 * Now supports external schema references, complex nested structures, and .merge().
 */
function extractSchemaFields(content, namedSchemas) {
    // Normalize the content first to handle multiline z.xxx calls
    const normalizedContent = normalizeZodCalls(content);

    let mainSchemaContent = null;
    let mergedSchema = null;

    // Check for .merge() pattern first
    // Look for: const Schema = something.merge(...) or const xxxSchema = something.merge(...)
    const schemaDefMatch = normalizedContent.match(/const\s+(Schema|\w+Schema)\s*=\s*/);
    if (schemaDefMatch) {
        const afterEquals = normalizedContent.substring(schemaDefMatch.index + schemaDefMatch[0].length);

        // Check if this definition contains .merge(
        if (afterEquals.includes('.merge(')) {
            // Find where the schema definition ends (look for newline followed by const/export/type/interface)
            const defEndMatch = afterEquals.match(/\n(?:const|export|type|interface|\/\/|\/\*)/);
            const schemaDefContent = defEndMatch ? afterEquals.substring(0, defEndMatch.index) : afterEquals.split('\n\n')[0];

            if (schemaDefContent.includes('.merge(')) {
                mergedSchema = parseMergeChain(schemaDefContent.trim(), namedSchemas);
                if (Object.keys(mergedSchema).length > 0) {
                    return mergedSchema;
                }
            }
        }
    }

    // Find the main/exported schema
    // Try multiple patterns: "const Schema = z.object", "const xxxSchema = z.object", etc.
    const patterns = [
        /const\s+Schema\s*=\s*z\.object\s*\(\s*\{/,
        /const\s+(\w+Schema)\s*=\s*z\.object\s*\(\s*\{/
    ];

    for (const pattern of patterns) {
        const match = normalizedContent.match(pattern);
        if (match) {
            const startPos = match.index + match[0].length - 1; // position of '{'
            const extracted = extractBalancedContent(normalizedContent, '{', '}', startPos);
            if (extracted) {
                mainSchemaContent = extracted.content;
                break;
            }
        }
    }

    // Fallback: look for z.object near "export const Schema"
    if (!mainSchemaContent) {
        const exportMatch = normalizedContent.match(/export\s+const\s+Schema\s*=\s*(\w+)/);
        if (exportMatch) {
            const schemaName = exportMatch[1];
            if (namedSchemas[schemaName]) {
                mainSchemaContent = namedSchemas[schemaName];
            }
        }
    }

    // Another fallback: find z.object that's followed by ".default" near end or export
    if (!mainSchemaContent) {
        // Look for the last major z.object definition
        const lastObjectMatch = normalizedContent.match(/z\.object\s*\(\s*\{([\s\S]*?)\}\s*\)\.default\s*\(/);
        if (lastObjectMatch) {
            mainSchemaContent = lastObjectMatch[1];
        }
    }

    if (!mainSchemaContent) {
        return {};
    }

    return parseObjectContent(mainSchemaContent, namedSchemas);
}

function parseObjectContent(objectContent, namedSchemas = {}) {
    const schema = {};

    // Normalize content first to handle multiline z.xxx calls
    const normalizedContent = normalizeZodCalls(objectContent);

    // Split by top-level properties
    const lines = normalizedContent.split('\n');
    let currentField = null;
    let currentContent = '';
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;

    for (const line of lines) {
        // Check if this is a new field definition at the top level BEFORE updating depths
        const isTopLevel = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;
        const fieldMatch = line.match(/^\s*(\w+)\s*:\s*(.*)$/);

        if (fieldMatch && isTopLevel) {
            // Save previous field if exists
            if (currentField) {
                schema[currentField] = parseFieldDefinition(currentContent, namedSchemas);
            }
            currentField = fieldMatch[1];
            currentContent = fieldMatch[2];
        } else if (currentField) {
            currentContent += '\n' + line;
        }

        // Update depths for this line
        for (const char of line) {
            if (char === '{') braceDepth++;
            else if (char === '}') braceDepth--;
            else if (char === '(') parenDepth++;
            else if (char === ')') parenDepth--;
            else if (char === '[') bracketDepth++;
            else if (char === ']') bracketDepth--;
        }
    }

    // Save last field
    if (currentField) {
        schema[currentField] = parseFieldDefinition(currentContent, namedSchemas);
    }

    return schema;
}

function parseFieldDefinition(fieldDef, namedSchemas = {}) {
    const result = { type: 'string' };

    // Normalize the field definition to handle multiline z.xxx calls
    const normalizedFieldDef = normalizeZodCalls(fieldDef);

    // Extract description from .meta({ description: '...' }) first
    const descMatch = normalizedFieldDef.match(/\.meta\(\s*\{\s*description\s*:\s*['"`]([^'"`]+)['"`]/);
    if (descMatch) {
        result.description = descMatch[1];
    }

    // Determine the primary type by finding what comes first: z.array or z.object
    const arrayIndex = normalizedFieldDef.indexOf('z.array(');
    const objectIndex = normalizedFieldDef.indexOf('z.object(');

    // Check for z.object FIRST if it appears before z.array (nested object case)
    if (objectIndex !== -1 && (arrayIndex === -1 || objectIndex < arrayIndex)) {
        result.type = 'object';
        const objStart = objectIndex + 9;
        const objContent = extractBalancedContent(normalizedFieldDef, '{', '}', objStart);
        if (objContent) {
            const innerSchema = parseObjectContent(objContent.content, namedSchemas);
            if (Object.keys(innerSchema).length > 0) {
                result.properties = innerSchema;
                result.required = Object.keys(innerSchema);
            }
        }
        return result;
    }

    // Check for z.array(...)
    if (arrayIndex !== -1) {
        result.type = 'array';

        // Extract array-level min/max (must be after the array closing)
        const arrayMinMatch = normalizedFieldDef.match(/\)\s*\.min\((\d+)\)/);
        const arrayMaxMatch = normalizedFieldDef.match(/\)\s*\.max\((\d+)\)/);
        if (arrayMinMatch) result.minItems = parseInt(arrayMinMatch[1]);
        if (arrayMaxMatch) result.maxItems = parseInt(arrayMaxMatch[1]);

        // Determine what's inside z.array(...)
        const arrayStart = normalizedFieldDef.indexOf('z.array(') + 8;
        const insideArray = extractBalancedContent(normalizedFieldDef, '(', ')', arrayStart - 1);

        if (insideArray) {
            const innerContent = insideArray.content.trim();

            // Check for z.array(z.array(...)) - 2D array
            if (innerContent.startsWith('z.array(')) {
                result.items = { type: 'array' };
                // Check what's inside the inner array
                if (innerContent.includes('z.string()')) {
                    result.items.items = { type: 'string' };
                } else if (innerContent.includes('z.number()')) {
                    result.items.items = { type: 'number' };
                }
                // Extract inner array's min/max
                const innerMinMatch = innerContent.match(/\)\s*\.min\((\d+)\)/);
                const innerMaxMatch = innerContent.match(/\)\s*\.max\((\d+)\)/);
                if (innerMinMatch) result.items.minItems = parseInt(innerMinMatch[1]);
                if (innerMaxMatch) result.items.maxItems = parseInt(innerMaxMatch[1]);
            }
            // Check for z.array(z.object({...}))
            else if (innerContent.includes('z.object(')) {
                const objStart = innerContent.indexOf('z.object(') + 9;
                const objContent = extractBalancedContent(innerContent, '{', '}', objStart);
                if (objContent) {
                    const innerSchema = parseObjectContent(objContent.content, namedSchemas);
                    if (Object.keys(innerSchema).length > 0) {
                        result.items = {
                            type: 'object',
                            properties: innerSchema,
                            required: Object.keys(innerSchema)
                        };
                    }
                }
            }
            // Check for z.array(z.string())
            else if (innerContent.includes('z.string()')) {
                result.items = { type: 'string' };
                const strMinMatch = innerContent.match(/\.min\((\d+)\)/);
                const strMaxMatch = innerContent.match(/\.max\((\d+)\)/);
                if (strMinMatch) result.items.minLength = parseInt(strMinMatch[1]);
                if (strMaxMatch) result.items.maxLength = parseInt(strMaxMatch[1]);
            }
            // Check for z.array(z.number())
            else if (innerContent.includes('z.number()')) {
                result.items = { type: 'number' };
            }
            // Check for z.array(NamedSchema) - reference to external schema
            else {
                const schemaRefMatch = innerContent.match(/^(\w+)(?:\.|$)/);
                if (schemaRefMatch) {
                    const refName = schemaRefMatch[1];
                    if (namedSchemas[refName]) {
                        const refSchema = parseObjectContent(namedSchemas[refName], namedSchemas);
                        if (Object.keys(refSchema).length > 0) {
                            result.items = {
                                type: 'object',
                                properties: refSchema,
                                required: Object.keys(refSchema)
                            };
                        }
                    }
                }
            }
        }

        return result;
    }

    // Check for z.string()
    if (normalizedFieldDef.includes('z.string()')) {
        result.type = 'string';
        const minMatch = normalizedFieldDef.match(/\.min\((\d+)\)/);
        const maxMatch = normalizedFieldDef.match(/\.max\((\d+)\)/);
        if (minMatch) result.minLength = parseInt(minMatch[1]);
        if (maxMatch) result.maxLength = parseInt(maxMatch[1]);
        return result;
    }

    // Check for z.number()
    if (normalizedFieldDef.includes('z.number()')) {
        result.type = 'number';
        const minMatch = normalizedFieldDef.match(/\.min\((\d+)\)/);
        const maxMatch = normalizedFieldDef.match(/\.max\((\d+)\)/);
        if (minMatch) result.minimum = parseInt(minMatch[1]);
        if (maxMatch) result.maximum = parseInt(maxMatch[1]);
        return result;
    }

    // Check for z.boolean()
    if (normalizedFieldDef.includes('z.boolean()')) {
        result.type = 'boolean';
        return result;
    }

    // Check for z.enum([...])
    if (normalizedFieldDef.includes('z.enum(')) {
        result.type = 'string';
        const enumMatch = normalizedFieldDef.match(/z\.enum\(\s*\[([\s\S]*?)\]/);
        if (enumMatch) {
            const enumValues = enumMatch[1].match(/['"`]([^'"`]+)['"`]/g);
            if (enumValues) {
                result.enum = enumValues.map(v => v.replace(/['"`]/g, ''));
            }
        }
        return result;
    }

    // Check for ImageSchema or IconSchema (imported schemas)
    if (normalizedFieldDef.includes('ImageSchema')) {
        result.type = 'object';
        result.properties = {
            __image_url__: { type: 'string', description: 'Image URL' },
            __image_prompt__: { type: 'string', description: 'Image generation prompt' }
        };
        return result;
    }

    if (normalizedFieldDef.includes('IconSchema')) {
        result.type = 'object';
        result.properties = {
            __icon_url__: { type: 'string', description: 'Icon URL' },
            __icon_query__: { type: 'string', description: 'Icon search query' }
        };
        return result;
    }

    // Check for reference to named schema (e.g., PointSchema, ChartDatumSchema)
    const schemaRefMatch = normalizedFieldDef.trim().match(/^(\w+Schema)(?:\.|,|\s|$)/);
    if (schemaRefMatch) {
        const refName = schemaRefMatch[1];
        if (namedSchemas[refName]) {
            result.type = 'object';
            const refSchema = parseObjectContent(namedSchemas[refName], namedSchemas);
            if (Object.keys(refSchema).length > 0) {
                result.properties = refSchema;
                result.required = Object.keys(refSchema);
            }
            return result;
        }
    }

    return result;
}

async function extractLayoutInfo(filePath, templateID) {
    const content = await fs.readFile(filePath, 'utf-8');
    const fileName = path.basename(filePath, '.tsx');

    // Extract layoutId - check both export patterns and const patterns
    let layoutId;
    const layoutIdExportMatch = content.match(/export\s+const\s+layoutId\s*=\s*['"`]([^'"`]+)['"`]/);
    const layoutIdConstMatch = content.match(/const\s+layoutId\s*=\s*['"`]([^'"`]+)['"`]/);
    if (layoutIdExportMatch) {
        layoutId = layoutIdExportMatch[1];
    } else if (layoutIdConstMatch) {
        layoutId = layoutIdConstMatch[1];
    } else {
        layoutId = fileName.toLowerCase().replace(/layout$/, '').replace(/slide$/, '');
    }

    // Extract layoutName
    let layoutName;
    const layoutNameExportMatch = content.match(/export\s+const\s+layoutName\s*=\s*['"`]([^'"`]+)['"`]/);
    const layoutNameConstMatch = content.match(/const\s+layoutName\s*=\s*['"`]([^'"`]+)['"`]/);
    if (layoutNameExportMatch) {
        layoutName = layoutNameExportMatch[1];
    } else if (layoutNameConstMatch) {
        layoutName = layoutNameConstMatch[1];
    } else {
        layoutName = fileName.replace(/([A-Z])/g, ' $1').trim();
    }

    // Extract layoutDescription
    let layoutDescription;
    const layoutDescExportMatch = content.match(/export\s+const\s+layoutDescription\s*=\s*['"`]([^'"`]+)['"`]/);
    const layoutDescConstMatch = content.match(/const\s+layoutDescription\s*=\s*['"`]([^'"`]+)['"`]/);
    if (layoutDescExportMatch) {
        layoutDescription = layoutDescExportMatch[1];
    } else if (layoutDescConstMatch) {
        layoutDescription = layoutDescConstMatch[1];
    } else {
        layoutDescription = `${layoutName} layout for presentations`;
    }

    // Extract all named schemas first (for cross-references)
    const namedSchemas = extractNamedSchemas(content);

    // Extract schema fields with named schema support
    const schemaFields = extractSchemaFields(content, namedSchemas);

    // Build JSON Schema
    const jsonSchema = {
        type: 'object',
        properties: schemaFields,
        required: Object.keys(schemaFields)
    };

    return {
        id: `${templateID}:${layoutId}`,
        name: layoutName,
        description: layoutDescription,
        json_schema: jsonSchema
    };
}

async function processTemplate(templateDir, templateID) {
    const files = await fs.readdir(templateDir);
    const layouts = [];
    let settings = { ordered: false };

    for (const file of files) {
        if (file === 'settings.json') {
            try {
                const settingsContent = await fs.readFile(path.join(templateDir, file), 'utf-8');
                settings = JSON.parse(settingsContent);
            } catch (e) {
                console.warn(`  Warning: Could not parse settings.json for ${templateID}`);
            }
            continue;
        }

        if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
        if (file.includes('.test.') || file.includes('.spec.')) continue;

        const filePath = path.join(templateDir, file);
        try {
            const layout = await extractLayoutInfo(filePath, templateID);
            layouts.push(layout);
            console.log(`    ✓ ${file} -> ${layout.id}`);
        } catch (e) {
            console.warn(`    ✗ ${file}: ${e.message}`);
        }
    }

    return {
        name: templateID,
        ordered: settings.ordered || false,
        slides: layouts
    };
}

async function main() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║   Pre-building Template Layouts        ║');
    console.log('╚════════════════════════════════════════╝\n');

    // Ensure output directory exists
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const templateDirs = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
    let totalLayouts = 0;

    for (const dir of templateDirs) {
        if (!dir.isDirectory()) continue;

        const templateID = dir.name;
        const templateDir = path.join(TEMPLATES_DIR, templateID);

        console.log(`📁 Processing: ${templateID}`);
        const templateData = await processTemplate(templateDir, templateID);
        totalLayouts += templateData.slides.length;

        const outputPath = path.join(OUTPUT_DIR, `${templateID}.json`);
        await fs.writeFile(outputPath, JSON.stringify(templateData, null, 2));
        console.log(`   Saved ${templateData.slides.length} layouts to ${templateID}.json\n`);
    }

    console.log('════════════════════════════════════════');
    console.log(`✅ Done! ${totalLayouts} layouts processed.`);
    console.log(`📂 Output: ${OUTPUT_DIR}`);
}

main().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});

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
 * Extract Zod schema fields from TypeScript code using improved regex.
 * This extracts more detailed schema information including constraints.
 */
function extractSchemaFields(content) {
    const schema = {};

    // Find the main schema definition (e.g., const bulletWithIconsSlideSchema = z.object({...}))
    const schemaMatch = content.match(/const\s+\w+Schema\s*=\s*z\.object\(\s*\{([\s\S]*?)\}\s*\)(?=\s*\n\s*export)/);
    if (!schemaMatch) {
        // Try alternative pattern
        const altMatch = content.match(/z\.object\(\s*\{([\s\S]*?)\}\s*\)(?=\s*\n\s*export)/);
        if (!altMatch) return schema;
        return parseObjectContent(altMatch[1]);
    }

    return parseObjectContent(schemaMatch[1]);
}

function parseObjectContent(objectContent) {
    const schema = {};

    // Split by top-level properties (look for property: z. pattern)
    const lines = objectContent.split('\n');
    let currentField = null;
    let currentContent = '';
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;

    for (const line of lines) {
        // Update depths for this line first
        let lineDepthChange = { brace: 0, paren: 0, bracket: 0 };
        for (const char of line) {
            if (char === '{') lineDepthChange.brace++;
            else if (char === '}') lineDepthChange.brace--;
            else if (char === '(') lineDepthChange.paren++;
            else if (char === ')') lineDepthChange.paren--;
            else if (char === '[') lineDepthChange.bracket++;
            else if (char === ']') lineDepthChange.bracket--;
        }

        // Check if this is a new field definition at the top level
        const fieldMatch = line.match(/^\s*(\w+)\s*:\s*(.*)$/);
        const isTopLevel = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;

        if (fieldMatch && isTopLevel) {
            // Save previous field if exists
            if (currentField) {
                schema[currentField] = parseFieldDefinition(currentContent);
            }
            currentField = fieldMatch[1];
            currentContent = fieldMatch[2];
        } else if (currentField) {
            currentContent += '\n' + line;
        }

        // Update running depths
        braceDepth += lineDepthChange.brace;
        parenDepth += lineDepthChange.paren;
        bracketDepth += lineDepthChange.bracket;
    }

    // Save last field
    if (currentField) {
        schema[currentField] = parseFieldDefinition(currentContent);
    }

    return schema;
}

/**
 * Extract content between matching braces starting from a position
 */
function extractBalancedContent(str, startChar = '{', endChar = '}') {
    const startIdx = str.indexOf(startChar);
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
                return str.substring(start, i);
            }
        }
    }
    return null;
}

function parseFieldDefinition(fieldDef) {
    const result = { type: 'string' };

    // Check for z.array(z.object({...})) FIRST - must be before z.string check
    if (fieldDef.includes('z.array(')) {
        result.type = 'array';

        // Extract min/max items from the array definition (after the closing paren of z.array())
        // We need to find .min() and .max() that are on the array, not on inner fields
        const arrayEndIdx = fieldDef.lastIndexOf('])');
        if (arrayEndIdx !== -1) {
            const afterArray = fieldDef.substring(arrayEndIdx);
            const minMatch = afterArray.match(/\.min\((\d+)\)/);
            const maxMatch = afterArray.match(/\.max\((\d+)\)/);
            if (minMatch) result.minItems = parseInt(minMatch[1]);
            if (maxMatch) result.maxItems = parseInt(maxMatch[1]);
        }

        // Try to parse inner object schema using balanced brace extraction
        if (fieldDef.includes('z.array(') && fieldDef.includes('z.object(')) {
            // Find where z.object starts
            const objectStart = fieldDef.indexOf('z.object(');
            if (objectStart !== -1) {
                const afterObjectKeyword = fieldDef.substring(objectStart + 'z.object('.length);
                // afterObjectKeyword starts with '{' already, so extract content directly
                const innerContent = extractBalancedContent(afterObjectKeyword, '{', '}');

                if (innerContent) {
                    const innerSchema = parseObjectContent(innerContent);
                    if (Object.keys(innerSchema).length > 0) {
                        result.items = {
                            type: 'object',
                            properties: innerSchema,
                            required: Object.keys(innerSchema)
                        };
                    }
                }
            }
        }

        // Extract description from .meta() on the array
        const descMatch = fieldDef.match(/\)\s*\.meta\(\s*\{\s*description\s*:\s*['"`]([^'"`]+)['"`]/);
        if (descMatch) {
            result.description = descMatch[1];
        }

        return result;
    }
    // Check for z.string()
    else if (fieldDef.includes('z.string()')) {
        result.type = 'string';
        // Extract min/max constraints
        const minMatch = fieldDef.match(/\.min\((\d+)\)/);
        const maxMatch = fieldDef.match(/\.max\((\d+)\)/);
        if (minMatch) result.minLength = parseInt(minMatch[1]);
        if (maxMatch) result.maxLength = parseInt(maxMatch[1]);
    }
    // Check for z.number()
    else if (fieldDef.includes('z.number()')) {
        result.type = 'number';
    }
    // Check for z.boolean()
    else if (fieldDef.includes('z.boolean()')) {
        result.type = 'boolean';
    }
    // Check for ImageSchema or IconSchema (imported schemas)
    else if (fieldDef.includes('ImageSchema')) {
        result.type = 'object';
        result.properties = {
            __image_url__: { type: 'string', description: 'Image URL' },
            __image_prompt__: { type: 'string', description: 'Image generation prompt' }
        };
    }
    else if (fieldDef.includes('IconSchema')) {
        result.type = 'object';
        result.properties = {
            __icon_url__: { type: 'string', description: 'Icon URL' },
            __icon_query__: { type: 'string', description: 'Icon search query' }
        };
    }
    // Check for z.object
    else if (fieldDef.includes('z.object(')) {
        result.type = 'object';
    }

    // Extract description from .meta({ description: '...' })
    const descMatch = fieldDef.match(/\.meta\(\s*\{\s*description\s*:\s*['"`]([^'"`]+)['"`]/);
    if (descMatch) {
        result.description = descMatch[1];
    }

    return result;
}

async function extractLayoutInfo(filePath, templateID) {
    const content = await fs.readFile(filePath, 'utf-8');
    const fileName = path.basename(filePath, '.tsx');

    // Extract layoutId
    const layoutIdMatch = content.match(/export\s+const\s+layoutId\s*=\s*['"`]([^'"`]+)['"`]/);
    const layoutId = layoutIdMatch ? layoutIdMatch[1] : fileName.toLowerCase().replace(/layout$/, '').replace(/slide$/, '');

    // Extract layoutName  
    const layoutNameMatch = content.match(/export\s+const\s+layoutName\s*=\s*['"`]([^'"`]+)['"`]/);
    const layoutName = layoutNameMatch ? layoutNameMatch[1] : fileName.replace(/([A-Z])/g, ' $1').trim();

    // Extract layoutDescription
    const layoutDescMatch = content.match(/export\s+const\s+layoutDescription\s*=\s*['"`]([^'"`]+)['"`]/);
    const layoutDescription = layoutDescMatch ? layoutDescMatch[1] : `${layoutName} layout for presentations`;

    // Extract schema fields
    const schemaFields = extractSchemaFields(content);

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

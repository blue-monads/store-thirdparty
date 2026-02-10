#! /usr/bin/env bun

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { $, YAML } from "bun";
const parseYaml = YAML.parse;
YAML

const REPOS = JSON.parse(readFileSync(join(import.meta.dir, "sources.json"), "utf-8"));

const BUILD_DIR = join(import.meta.dir, "build");
const HARVEST_DIR = join(import.meta.dir, "harvest");
const HARVEST_INDEX_PATH = join(import.meta.dir, "harvest-index.json");

// Ensure directories exist
mkdirSync(BUILD_DIR, { recursive: true });
mkdirSync(HARVEST_DIR, { recursive: true });

// Global tag index: Map<tag, Set<slug>>
const tagIndex: Map<string, Set<string>> = new Map();

// Load harvest index
let harvestIndex: any;
if (existsSync(HARVEST_INDEX_PATH)) {
    harvestIndex = JSON.parse(readFileSync(HARVEST_INDEX_PATH, "utf-8"));
} else {
    harvestIndex = {
        name: "Official Potato Field",
        info: "Official Potato Field for PotatoVerse",
        type: "harvester-v1",
        zip_template: "/harvest/{slug}/{slug}.{version}.spk.zip",
        indexed_tags: ["official"],
        indexed_tag_template: "/tags/{tag}.json",
        potatoes: []
    };
}

// Initialize tag index from existing potatoes in harvest index
for (const potato of harvestIndex.potatoes) {
    const tags = potato.tags || [];
    for (const tag of tags) {
        if (!tagIndex.has(tag)) {
            tagIndex.set(tag, new Set());
        }
        tagIndex.get(tag)!.add(potato.slug);
    }
}

// Find potato.yaml files recursively
function findPotatoYamlFiles(dir: string): string[] {
    const files: string[] = [];
    
    function walk(currentDir: string) {
        if (!existsSync(currentDir)) return;
        
        const entries = readdirSync(currentDir);
        
        for (const entry of entries) {
            const fullPath = join(currentDir, entry);
            const stat = statSync(fullPath);
            
            if (stat.isDirectory()) {
                // Skip .git and node_modules
                if (entry === ".git" || entry === "node_modules") continue;
                walk(fullPath);
            } else if (entry === "potato.yaml" || entry === "potato.yml") {
                files.push(fullPath);
            }
        }
    }
    
    walk(dir);
    return files;
}

// Parse YAML file
function parseYamlFile(filePath: string): any {
    const content = readFileSync(filePath, "utf-8");
    return parseYaml(content);
}

// Find or create potato entry in harvest index
function findPotatoEntry(slug: string): any {
    return harvestIndex.potatoes.find((p: any) => p.slug === slug);
}

// Check if version already exists
function versionExists(potato: any, version: string): boolean {
    return potato && potato.versions && potato.versions.includes(version);
}

// Update harvest index
function updateHarvestIndex(slug: string, version: string, potatoYaml: any) {
    let potato = findPotatoEntry(slug);
    
    if (!potato) {
        // Create new entry
        potato = {
            name: potatoYaml.name || "",
            info: potatoYaml.info || "",
            slug: slug,
            tags: potatoYaml.tags || [],
            author_name: potatoYaml.author_name || "",
            author_email: potatoYaml.author_email || "",
            author_site: potatoYaml.author_site || "",
            license: potatoYaml.license || "",
            current_version: version,
            versions: [version]
        };
        harvestIndex.potatoes.push(potato);
    } else {
        // Update existing entry
        if (!potato.versions) {
            potato.versions = [];
        }
        if (!potato.versions.includes(version)) {
            potato.versions.push(version);
        }
        potato.current_version = version;
        // Update other fields if they're missing
        if (!potato.name && potatoYaml.name) potato.name = potatoYaml.name;
        if (!potato.info && potatoYaml.info) potato.info = potatoYaml.info;
        if (!potato.tags && potatoYaml.tags) potato.tags = potatoYaml.tags;
        if (!potato.author_name && potatoYaml.author_name) potato.author_name = potatoYaml.author_name;
        if (!potato.author_email && potatoYaml.author_email) potato.author_email = potatoYaml.author_email;
        if (!potato.author_site && potatoYaml.author_site) potato.author_site = potatoYaml.author_site;
        if (!potato.license && potatoYaml.license) potato.license = potatoYaml.license;
    }
}

// Main build process
for (const repo of REPOS) {
    console.log(`Processing repo: ${repo.name}`);
    
    const repoDir = join(BUILD_DIR, repo.name);
    
    // Clone or update repo
    if (existsSync(repoDir)) {
        console.log(`  Updating existing repo...`);
        await $`cd ${repoDir} && git pull`.quiet();
    } else {
        console.log(`  Cloning repo...`);
        await $`git clone ${repo.url} ${repoDir}`.quiet();
    }
    
    // Find all potato.yaml files
    const potatoYamlFiles = findPotatoYamlFiles(repoDir);
    console.log(`  Found ${potatoYamlFiles.length} potato.yaml file(s)`);
    
    for (const yamlPath of potatoYamlFiles) {
        const packageDir = dirname(yamlPath);
        const relativePath = packageDir.replace(repoDir + "/", "");
        
        console.log(`  Processing: ${relativePath}`);
        
        try {
            // Parse potato.yaml
            const potatoYaml = parseYamlFile(yamlPath);
            const slug = potatoYaml.slug;
            const version = potatoYaml.version;
            
            if (!slug || !version) {
                console.log(`    ⚠️  Skipping: missing slug or version`);
                continue;
            }
            
            console.log(`    Slug: ${slug}, Version: ${version}`);
            
            // Check if version already exists
            const existingPotato = findPotatoEntry(slug);
            if (versionExists(existingPotato, version)) {
                console.log(`    ✓ Version ${version} already exists, skipping`);
                continue;
            }
            
            // Build package
            console.log(`    Building package...`);
            const buildResult = await $`cd ${packageDir} && potatoverse package build`;
            
            if (buildResult.exitCode !== 0) {
                console.log(`    ✗ Build failed`);
                continue;
            }
            
            // Find the output zip file
            // Check developer.output_zip_file from potato.yaml first
            let zipPath: string | null = null;
            const outputZipFile = potatoYaml.developer?.output_zip_file || "package.spk.zip";
            
            const possibleZipPaths = [
                join(packageDir, outputZipFile),
                join(packageDir, "package.spk.zip"),
                join(packageDir, "potato.spk.zip"),
                outputZipFile,
                "package.spk.zip",
                "potato.spk.zip"
            ];
            
            for (const zipName of possibleZipPaths) {
                if (existsSync(zipName)) {
                    zipPath = zipName;
                    break;
                }
            }
            
            if (!zipPath) {
                console.log(`    ✗ Could not find output zip file (looked for: ${outputZipFile})`);
                continue;
            }
            
            // Copy to harvest directory with nested structure: harvest/{slug}/{slug}.{version}.spk.zip
            const slugDir = join(HARVEST_DIR, slug);
            mkdirSync(slugDir, { recursive: true });
            const harvestZipName = `${slug}.${version}.spk.zip`;
            const harvestZipPath = join(slugDir, harvestZipName);
            copyFileSync(zipPath, harvestZipPath);
            console.log(`    ✓ Copied to harvest: ${slug}/${harvestZipName}`);
            
            // Update harvest index
            updateHarvestIndex(slug, version, potatoYaml);
            console.log(`    ✓ Updated harvest index`);
            
            // Update global tag index
            const tags = potatoYaml.tags || [];
            for (const tag of tags) {
                if (!tagIndex.has(tag)) {
                    tagIndex.set(tag, new Set());
                }
                tagIndex.get(tag)!.add(slug);
            }
            
        } catch (error) {
            console.log(`    ✗ Error: ${error}`);
        }
    }
}

// Update indexed_tags with all tags found
const allTags = Array.from(tagIndex.keys()).sort();
harvestIndex.indexed_tags = allTags;
console.log(`\nFound ${allTags.length} unique tags: ${allTags.join(", ")}`);

// Save updated harvest index
writeFileSync(HARVEST_INDEX_PATH, JSON.stringify(harvestIndex, null, 4));
console.log(`✓ Harvest index saved to ${HARVEST_INDEX_PATH}`);

// Generate tag index files for all tags found
function generateTagIndexes() {
    const tagTemplate = harvestIndex.indexed_tag_template || "/tags/{tag}.json";
    const TAGS_DIR = join(import.meta.dir, "tags");
    
    mkdirSync(TAGS_DIR, { recursive: true });
    
    if (tagIndex.size === 0) {
        console.log(`\nNo tags found, skipping tag index generation`);
        return;
    }
    
    console.log(`\nGenerating tag indexes for all ${tagIndex.size} tags...`);
    
    // Create a map of slug -> potato for quick lookup
    const slugToPotato = new Map<string, any>();
    for (const potato of harvestIndex.potatoes) {
        slugToPotato.set(potato.slug, potato);
    }
    
    // Generate index for each tag
    for (const [tag, slugSet] of tagIndex.entries()) {
        // Get all potatoes for this tag
        const taggedPotatoes = Array.from(slugSet)
            .map(slug => slugToPotato.get(slug))
            .filter(potato => potato !== undefined);
        
        // Create tag index structure
        const tagIndexData = {
            tag: tag,
            count: taggedPotatoes.length,
            potatoes: taggedPotatoes.map((potato: any) => ({
                name: potato.name,
                info: potato.info,
                slug: potato.slug,
                tags: potato.tags,
                author_name: potato.author_name,
                author_email: potato.author_email,
                author_site: potato.author_site,
                license: potato.license,
                current_version: potato.current_version,
                versions: potato.versions
            }))
        };
        
        // Generate file path from template
        const tagFilePath = tagTemplate.replace("{tag}", tag);
        // Remove leading slash if present and resolve relative to store directory
        const resolvedPath = tagFilePath.startsWith("/") 
            ? join(import.meta.dir, tagFilePath.slice(1))
            : join(import.meta.dir, tagFilePath);
        
        // Ensure directory exists
        mkdirSync(dirname(resolvedPath), { recursive: true });
        
        // Write tag index file
        writeFileSync(resolvedPath, JSON.stringify(tagIndexData, null, 4));
        console.log(`  ✓ Generated ${tagFilePath} (${taggedPotatoes.length} potatoes)`);
    }
}

generateTagIndexes();
console.log(`\n✓ Tag indexes generated`);
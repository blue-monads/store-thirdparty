#! /usr/bin/env bun

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { $ } from "bun";

const REPOS = [{
    name: "potato-apps",
    url: "https://github.com/blue-monads/potato-apps",
}]

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

// Find potato.toml files recursively
function findPotatoTomlFiles(dir: string): string[] {
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
            } else if (entry === "potato.toml") {
                files.push(fullPath);
            }
        }
    }
    
    walk(dir);
    return files;
}

// Parse TOML file (Bun has built-in TOML support)
function parseToml(filePath: string): any {
    const content = readFileSync(filePath, "utf-8");
    return Bun.TOML.parse(content);
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
function updateHarvestIndex(slug: string, version: string, potatoToml: any) {
    let potato = findPotatoEntry(slug);
    
    if (!potato) {
        // Create new entry
        potato = {
            name: potatoToml.name || "",
            info: potatoToml.info || "",
            slug: slug,
            tags: potatoToml.tags || [],
            author_name: potatoToml.author_name || "",
            author_email: potatoToml.author_email || "",
            author_site: potatoToml.author_site || "",
            license: potatoToml.license || "",
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
        if (!potato.name && potatoToml.name) potato.name = potatoToml.name;
        if (!potato.info && potatoToml.info) potato.info = potatoToml.info;
        if (!potato.tags && potatoToml.tags) potato.tags = potatoToml.tags;
        if (!potato.author_name && potatoToml.author_name) potato.author_name = potatoToml.author_name;
        if (!potato.author_email && potatoToml.author_email) potato.author_email = potatoToml.author_email;
        if (!potato.author_site && potatoToml.author_site) potato.author_site = potatoToml.author_site;
        if (!potato.license && potatoToml.license) potato.license = potatoToml.license;
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
    
    // Find all potato.toml files
    const potatoTomlFiles = findPotatoTomlFiles(repoDir);
    console.log(`  Found ${potatoTomlFiles.length} potato.toml file(s)`);
    
    for (const tomlPath of potatoTomlFiles) {
        const packageDir = dirname(tomlPath);
        const relativePath = packageDir.replace(repoDir + "/", "");
        
        console.log(`  Processing: ${relativePath}`);
        
        try {
            // Parse potato.toml
            const potatoToml = parseToml(tomlPath);
            const slug = potatoToml.slug;
            const version = potatoToml.version;
            
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
            // Check developer.output_zip_file from potato.toml first
            let zipPath: string | null = null;
            const outputZipFile = potatoToml.developer?.output_zip_file || "package.spk.zip";
            
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
            updateHarvestIndex(slug, version, potatoToml);
            console.log(`    ✓ Updated harvest index`);
            
            // Update global tag index
            const tags = potatoToml.tags || [];
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
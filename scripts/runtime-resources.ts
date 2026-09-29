import assert from 'node:assert/strict'

export function replaceOnce(source: string, before: string, after: string) {
 assert.equal(source.split(before).length, 2, `Upstream resource boundary changed: ${before}`)
 return source.replace(before, after)
}

export function isolateResourceSource(source: string, kind: 'packages' | 'loader') {
 if (kind === 'loader') return replaceOnce(source, 'const globalExtDir = path.join(resolvedAgentDir, "extensions");', 'const globalExtDir = process.env.TIA_AGENT_EXTENSIONS_DIR || path.join(resolvedAgentDir, "extensions");')
 let result = replaceOnce(source, 'extensions: join(globalBaseDir, "extensions"),', 'extensions: process.env.TIA_AGENT_EXTENSIONS_DIR || join(globalBaseDir, "extensions"),')
 result = replaceOnce(
  result,
  'const globalEntries = (globalSettings[resourceType] ?? []);',
  `const globalEntries = (globalSettings[resourceType] ?? []).map(entry => {
 if (resourceType !== "extensions" || !process.env.TIA_AGENT_EXTENSIONS_DIR || typeof entry !== "string" || isPattern(entry) || !isLocalPath(entry)) return entry;
 const original = this.resolvePathFromBase(entry, globalBaseDir);
 const suffix = relative(join(globalBaseDir, "extensions"), original);
 return suffix !== ".." && !suffix.startsWith(".." + sep) && !suffix.startsWith(sep) ? join(process.env.TIA_AGENT_EXTENSIONS_DIR, suffix) : entry;
});`
 )
 result = replaceOnce(
  result,
  'const enabled = isEnabledByOverrides(path, overrides, baseDir);',
  `const logicalPath = resourceType === "extensions" && metadata === userMetadata && process.env.TIA_AGENT_EXTENSIONS_DIR ? join(globalBaseDir, "extensions", relative(userDirs.extensions, path)) : path;
                const enabled = isEnabledByOverrides(logicalPath, overrides, baseDir);`
 )
 return result
}

export function pinNativeHelpers(source: string) {
 const original = "const fastToolsDir = () => join(getAgentDir(), 'fast-tools')"
 const adapted = "const fastToolsDir = () => process.env.TIA_FAST_TOOLS_DIR || join(getAgentDir(), 'fast-tools')"
 if (source.includes(adapted)) return source
 if (!source.includes('FASTDRAIN_BIN') && !source.includes('FASTCOPY_BIN')) return source
 return replaceOnce(source, original, adapted)
}

import {expect, test} from 'bun:test'
import {mkdtempSync, rmSync} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {combinedEditDiff, duplicateEditError, editToolDescription, editToolPromptSnippet, missingEditError, planClassicEdits, planPatch} from './fast-tools-extension'

test('edit diagnostics explain indentation-only exact-match failures', () => {
 const content = 'function render() {\n\tfields.push({label:"skills",value:"—"});\n\tfields.push({label:"spawning",value:"false"});\n}\n'
 const oldText = 'fields.push({label:"skills",value:"—"});\nfields.push({label:"spawning",value:"false"});'

 const error = missingEditError('sample.ts', 0, content, oldText)

 expect(error.message).toContain('Edit failed in sample.ts: edits[0].oldText was not found exactly')
 expect(error.message).toContain('Nearest match starts at line 2 and differs only after trimming whitespace.')
 expect(error.message).toContain('Actual first line prefix: "\\tfields.push')
 expect(error.message).toContain('Fix: Retry with the actual whitespace from actualPrefix, or use patch for indentation-sensitive edits.')
 expect(error.details).toEqual(expect.objectContaining({reason: 'indentation_mismatch', editIndex: 0, path: 'sample.ts', line: 2, matchType: 'trimmed_whitespace', confidence: 0.98, suggestion: 'Retry with the actual whitespace from actualPrefix, or use patch for indentation-sensitive edits.'}))
})

test('duplicate exact-match failures include locations and recovery guidance', () => {
 const content = 'alpha\ntarget\nbeta\n\ngamma\ntarget\ndelta\n'
 const error = duplicateEditError('sample.txt', 0, content, 'target')

 expect(error.message).toContain('Edit failed in sample.txt: edits[0].oldText matched 2 places')
 expect(error.message).toContain('Match lines: 2, 6')
 expect(error.message).toContain('Fix: include more surrounding context in oldText, or use patch.')
 expect(error.details).toEqual(expect.objectContaining({reason: 'duplicate_match', count: 2, locations: [2, 6]}))
})

test('edit tool description gives low-token guidance for exact, multi, and patch modes', () => {
 expect(editToolDescription).toContain('Use patch for non-trivial code edits')
 expect(editToolDescription).toContain('exact oldText/edits[]/multi[] only for tiny fresh verbatim replacements')
 expect(editToolPromptSnippet).toContain('Edit choice: patch for non-trivial code edits')
 expect(editToolPromptSnippet).toContain('If exact fails once, reread or patch')
})

test('edit render diff avoids redundant unified file headers', () => {
 const single = combinedEditDiff([{path: 'src/app.ts', absolutePath: '/repo/src/app.ts', before: 'alpha\nbeta\n', after: 'alpha\nbetter\n', editCount: 1}])
 expect(single).not.toContain('--- src/app.ts')
 expect(single).not.toContain('+++ src/app.ts')
 expect(single).toContain('-2 beta')
 expect(single).toContain('+2 better')

 const multi = combinedEditDiff([
  {path: 'src/app.ts', absolutePath: '/repo/src/app.ts', before: 'alpha\n', after: 'apricot\n', editCount: 1},
  {path: 'src/util.ts', absolutePath: '/repo/src/util.ts', before: 'gamma\n', after: 'green\n', editCount: 1}
 ])
 expect(multi).toContain('src/app.ts\n-1 alpha\n+1 apricot')
 expect(multi).toContain('src/util.ts\n-1 gamma\n+1 green')
 expect(multi).not.toContain('--- src/app.ts')
 expect(multi).not.toContain('+++ src/app.ts')
})

test('classic multi-file edits preflight all files before producing planned writes', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-classic-edit-test-'))
 try {
  await writeFile(join(cwd, 'one.txt'), 'alpha\nbeta\n')
  await writeFile(join(cwd, 'two.txt'), 'gamma\ndelta\n')

  const plans = await planClassicEdits(
   cwd,
   [
    {path: 'one.txt', oldText: 'alpha', newText: 'ALPHA'},
    {path: 'two.txt', oldText: 'delta', newText: 'DELTA'}
   ],
   path => readFile(path, 'utf8')
  )

  expect(plans.map(plan => [plan.path, plan.after])).toEqual([
   ['one.txt', 'ALPHA\nbeta\n'],
   ['two.txt', 'gamma\nDELTA\n']
  ])
  expect(await readFile(join(cwd, 'one.txt'), 'utf8')).toBe('alpha\nbeta\n')
  expect(await readFile(join(cwd, 'two.txt'), 'utf8')).toBe('gamma\ndelta\n')
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('patch updates a hunk with indentation drift and fails ambiguous hunks', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-patch-test-'))
 try {
  const target = join(cwd, 'sample.ts')
  await writeFile(target, 'function render() {\n\tfields.push("skills")\n}\n')
  const patch = `*** Begin Patch
*** Update File: sample.ts
@@
-fields.push("skills")
+fields.push("skills")
+fields.push("spawning")
*** End Patch`

  const plans = await planPatch(
   cwd,
   patch,
   path => readFile(path, 'utf8'),
   async () => true
  )
  expect(plans[0].after).toBe('function render() {\n\tfields.push("skills")\n\tfields.push("spawning")\n}\n')

  await writeFile(target, 'same\nsame\n')
  const ambiguous = `*** Begin Patch
*** Update File: sample.ts
@@
-same
+changed
*** End Patch`
  try {
   await planPatch(
    cwd,
    ambiguous,
    path => readFile(path, 'utf8'),
    async () => true
   )
   throw new Error('Expected ambiguous patch to fail')
  } catch (error) {
   if (!(error instanceof Error)) throw error
   expect(error.message).toMatch(/ambiguous/)
  }
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('patch accepts standard unified diff update, add, and delete payloads', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-unified-patch-test-'))
 try {
  await writeFile(join(cwd, 'sample.txt'), 'alpha\nbeta\ngamma\n')
  await writeFile(join(cwd, 'remove.txt'), 'delete me\n')
  const patch = `*** Begin Patch
--- a/sample.txt
+++ b/sample.txt
@@ -1,3 +1,4 @@
 alpha
-beta
+better
 gamma
+delta
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+created
+by unified diff
--- a/remove.txt
+++ /dev/null
@@ -1 +0,0 @@
-delete me
*** End Patch`

  const plans = await planPatch(
   cwd,
   patch,
   path => readFile(path, 'utf8'),
   async absolutePath => absolutePath !== join(cwd, 'added.txt')
  )

  expect(plans.map(plan => [plan.path, plan.after])).toEqual([
   ['sample.txt', 'alpha\nbetter\ngamma\ndelta\n'],
   ['added.txt', 'created\nby unified diff\n'],
   ['remove.txt', null]
  ])
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('patch accepts bare unified diff and git diff payloads without wrapper ceremony', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-bare-unified-patch-test-'))
 try {
  await writeFile(join(cwd, 'sample.txt'), 'alpha\nbeta\ngamma\n')
  await writeFile(join(cwd, 'git.txt'), 'one\ntwo\n')

  const bareUnified = `--- a/sample.txt
+++ b/sample.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+better
 gamma`
  const barePlans = await planPatch(
   cwd,
   bareUnified,
   path => readFile(path, 'utf8'),
   async () => true
  )
  expect(barePlans[0].after).toBe('alpha\nbetter\ngamma\n')

  const gitDiff = `diff --git a/git.txt b/git.txt
index 1111111..2222222 100644
--- a/git.txt
+++ b/git.txt
@@ -1,2 +1,2 @@
 one
-two
+too`
  const gitPlans = await planPatch(
   cwd,
   gitDiff,
   path => readFile(path, 'utf8'),
   async () => true
  )
  expect(gitPlans[0].after).toBe('one\ntoo\n')
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('patch accepts multi-file git diff payloads', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-multifile-git-patch-test-'))
 try {
  await writeFile(join(cwd, 'one.txt'), 'alpha\nbeta\n')
  await writeFile(join(cwd, 'two.txt'), 'gamma\ndelta\n')
  const patch = `diff --git a/one.txt b/one.txt
index 1111111..2222222 100644
--- a/one.txt
+++ b/one.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+better
diff --git a/two.txt b/two.txt
index 3333333..4444444 100644
--- a/two.txt
+++ b/two.txt
@@ -1,2 +1,2 @@
 gamma
-delta
+denim`

  const plans = await planPatch(
   cwd,
   patch,
   path => readFile(path, 'utf8'),
   async () => true
  )

  expect(plans.map(plan => [plan.path, plan.after])).toEqual([
   ['one.txt', 'alpha\nbetter\n'],
   ['two.txt', 'gamma\ndenim\n']
  ])
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('wrapped update patch tolerates unified file headers after Update File', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-wrapped-unified-header-test-'))
 try {
  await writeFile(join(cwd, 'sample.txt'), 'alpha\nbeta\n')
  const patch = `*** Begin Patch
*** Update File: sample.txt
--- a/sample.txt
+++ b/sample.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+better
*** End Patch`

  const plans = await planPatch(
   cwd,
   patch,
   path => readFile(path, 'utf8'),
   async () => true
  )

  expect(plans[0].after).toBe('alpha\nbetter\n')
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('wrapped add file tolerates unified headers without writing them as content', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-wrapped-add-header-test-'))
 try {
  const patch = `*** Begin Patch
*** Add File: created.ts
--- /dev/null
+++ b/created.ts
@@ -0,0 +1,2 @@
+export const created = true
+export const value = 1
*** End Patch`

  const plans = await planPatch(
   cwd,
   patch,
   path => readFile(path, 'utf8'),
   async () => false
  )

  expect(plans[0]).toEqual(expect.objectContaining({path: 'created.ts', before: null, after: 'export const created = true\nexport const value = 1\n'}))
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('wrapped delete file tolerates unified delete body without planning duplicate deletes', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-wrapped-delete-header-test-'))
 try {
  await writeFile(join(cwd, 'delete.ts'), 'export const gone = true\n')
  const patch = `*** Begin Patch
*** Delete File: delete.ts
--- a/delete.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const gone = true
*** End Patch`

  const plans = await planPatch(
   cwd,
   patch,
   path => readFile(path, 'utf8'),
   async () => true
  )

  expect(plans).toHaveLength(1)
  expect(plans[0]).toEqual(expect.objectContaining({path: 'delete.ts', before: 'export const gone = true\n', after: null}))
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('patch format errors teach the expected file header syntax', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-patch-error-test-'))
 try {
  const badPatch = `*** Begin Patch
@@ -1,1 +1,1 @@
-old
+new
*** End Patch`

  try {
   await planPatch(
    cwd,
    badPatch,
    path => readFile(path, 'utf8'),
    async () => true
   )
   throw new Error('Expected invalid patch header to fail')
  } catch (error) {
   if (!(error instanceof Error)) throw error
   expect(error.message).toMatch(/Accepted patch forms:/)
  }
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('patch update misses report path once with concise recovery guidance', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-patch-miss-message-test-'))
 try {
  await writeFile(join(cwd, 'sample.txt'), 'alpha\nbeta\n')
  const patch = `--- a/sample.txt
+++ b/sample.txt
@@ -1,2 +1,2 @@
 alpha
-missing
+better`

  try {
   await planPatch(
    cwd,
    patch,
    path => readFile(path, 'utf8'),
    async () => true
   )
   throw new Error('Expected patch planning to fail')
  } catch (error) {
   if (!(error instanceof Error)) throw error
   expect(error.message).toContain('Patch failed in sample.txt.\nExpected lines were not found:\nalpha\nmissing\nFix: reread that region')
  }
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('patch add existing file fails instead of replacing content', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-patch-add-existing-test-'))
 try {
  await writeFile(join(cwd, 'sample.txt'), 'original\n')
  const patch = `--- /dev/null
+++ b/sample.txt
@@ -0,0 +1 @@
+replacement`

  try {
   await planPatch(
    cwd,
    patch,
    path => readFile(path, 'utf8'),
    async absolutePath => absolutePath === join(cwd, 'sample.txt')
   )
   throw new Error('Expected add-existing patch to fail')
  } catch (error) {
   if (!(error instanceof Error)) throw error
   expect(error.message).toContain('Patch failed in sample.txt: file already exists')
  }
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('classic edit modes reject empty oldText before matching', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-empty-oldtext-test-'))
 try {
  await writeFile(join(cwd, 'sample.txt'), 'alpha\n')

  for (const edits of [
   [{path: 'sample.txt', oldText: '', newText: 'x'}],
   [
    {path: 'sample.txt', oldText: 'alpha', newText: 'x'},
    {path: 'sample.txt', oldText: '', newText: 'y'}
   ]
  ]) {
   try {
    await planClassicEdits(cwd, edits, path => readFile(path, 'utf8'))
    throw new Error('Expected empty oldText to fail')
   } catch (error) {
    if (!(error instanceof Error)) throw error
    expect(error.message).toContain('oldText')
   }
  }
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('patch add file accepts raw content lines as a recovery-friendly fallback', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-raw-add-patch-test-'))
 try {
  const patch = `*** Begin Patch
*** Add File: notes.md
# Notes

Raw content without plus prefixes should still create the file.
*** End Patch`

  const plans = await planPatch(
   cwd,
   patch,
   path => readFile(path, 'utf8'),
   async () => false
  )

  expect(plans[0]).toEqual(expect.objectContaining({path: 'notes.md', before: null, after: '# Notes\n\nRaw content without plus prefixes should still create the file.\n'}))
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

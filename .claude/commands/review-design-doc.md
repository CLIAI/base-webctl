---
description: Interactive Socratic review of a design doc branch, section by section
argument-hint: <branch-name>
allowed-tools: ["Read", "Bash", "Edit", "Write", "AskUserQuestion", "Grep", "Glob"]
---

# Interactive Design Document Review

You are conducting a **Socratic review** of a design document with the user. Your goal is to walk through the document section by section, ensure the user understands and agrees with each part, and collaboratively refine it before merging.

## Input

Branch name from `$ARGUMENTS`. The branch contains a single design doc under `docs/design/`.

## Process

### Step 0: Setup

1. Parse branch name from `$ARGUMENTS`. If empty, list available unmerged `design/*` branches and use AskUserQuestion to let user pick one.
2. Read the design doc from the branch: `git show $BRANCH:docs/design/<filename>`
   - Find the filename: `git ls-tree --name-only $BRANCH -- docs/design/ | grep -v DESIGN_DOCS`
3. Parse the document into logical sections. A "section" is typically an H2 (`##`) heading and its content. Group small sections (under ~100 words) with the next section. Each review chunk should be ~100-400 words.
4. Count total sections. Display a brief overview to the user:
   - Document title, ID, category, tags
   - Number of sections to review
   - Estimated review time (~1-2 min per section)

### Step 1: Section-by-Section Review Loop

For each section (in order):

1. **Present the section**: Display the full text of the current section with a header like:
   ```
   ## Section X/N: {Section Title}
   ```
   Show the raw markdown content so the user can see exactly what's written.

2. **Socratic Review**: Use `AskUserQuestion` with thought-provoking questions. The questions should:
   - Test understanding: "Does this principle apply to your use cases?"
   - Challenge assumptions: "Can you think of a scenario where this pattern would fail?"
   - Validate design: "Is the trade-off described here the right one for your framework?"
   - Check completeness: "Is anything missing from this section?"

   Provide options like:
   - "Approve as-is" — section is good, move on
   - "Needs minor edits" — small wording/clarity fixes (describe in notes)
   - "Needs rework" — fundamental issues with the approach
   - "Remove section" — not relevant or duplicates another doc

   IMPORTANT: Vary your questions! Don't ask the same generic questions for every section. Tailor questions to the specific content — ask about the specific patterns, trade-offs, code examples, or design decisions in THAT section.

3. **Apply Changes** (if requested):
   - For minor edits: ask user to describe changes, then apply with Edit tool on the branch
   - For rework: discuss with user what should change, rewrite the section, show the result, and re-review
   - For removal: confirm, then remove the section
   - After ANY edit, run `uv run scripts/verify_yaml_frontmatter.py docs/design/` to validate

4. **Progress indicator**: After each section, show `[X/N sections reviewed]`

### Step 2: Final Review

After all sections:

1. Show a summary of all decisions made:
   - Sections approved as-is
   - Sections that were edited (briefly describe changes)
   - Sections removed
2. If any edits were made, show the final diff: `git diff` on the branch
3. Ask user for final approval to merge

### Step 3: Merge

If approved:

```bash
# Ensure we're on the branch with all changes committed
git checkout $BRANCH

# Commit any pending edits (if changes were made during review)
git add docs/design/*.md
git commit -m "Incorporate review feedback for <doc-title>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

# Rebase onto master for linear history
git rebase master

# Switch to master and fast-forward merge
git checkout master
git merge --ff-only $BRANCH

# Clean up merged branch
git branch -d $BRANCH
```

Report success with the merge commit hash.

## Tone & Style

- Be a **curious collaborator**, not a rubber stamp
- Ask questions that reveal whether the design is *actually useful* vs *theoretically nice*
- When presenting sections, add brief context connecting to earlier sections
- If you spot issues (inconsistencies, missing edge cases, vague language), raise them proactively in your questions
- Keep your commentary concise — the document content speaks for itself
- Use the user's feedback to improve questions for later sections (adaptive)

## Edge Cases

- If branch has no design doc, report error and exit
- If branch is already merged into master, report and exit
- If user wants to abort mid-review, confirm and return to master without merging
- If rebase has conflicts, report them and let user decide how to proceed

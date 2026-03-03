#!/usr/bin/env -S uv run
# /// script
# dependencies = [
#   "python-frontmatter>=1.1",
#   "pydantic>=2.0",
#   "typing-extensions>=4.0",
# ]
# requires-python = ">=3.11"
# ///
"""Validate YAML front matter in design documents.

Usage: python3 scripts/verify_yaml_frontmatter.py [docs/design/]

Checks:
  - YAML parses without error
  - All required fields present with correct types
  - id matches filename postfix (4-char [a-z0-9])
  - category matches filename prefix
  - Referenced IDs in relationship fields exist
  - No duplicate IDs across documents
  - Date fields valid ISO, updated >= created
  - Known categories enforced (with easy extension)

Deps: pip install python-frontmatter pydantic
"""
from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path
from typing import Optional

import frontmatter
import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from typing_extensions import Self

# ── Known categories (extend here when adding new prefixes) ───────────────────

KNOWN_CATEGORIES = {
    "ux", "safety", "infra", "data", "arch", "test", "ops", "meta",
}

ID_RE = re.compile(r"^[a-z0-9]{4}$")
FILENAME_RE = re.compile(r"^([a-z]+)-(.+)-([a-z0-9]{4})\.md$")


# ── Tech entry model ─────────────────────────────────────────────────────────

class TechEntry(BaseModel):
    name: str
    version: str = ""


# ── Front matter schema ──────────────────────────────────────────────────────

class DocFrontmatter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    category: str
    created: str
    updated: str
    status: str
    tags: list[str] = Field(default_factory=list)
    tech: list = Field(default_factory=list)
    relates_to: list[str] = Field(default_factory=list)
    depends_on: list[str] = Field(default_factory=list)
    expands: list[str] = Field(default_factory=list)
    similar_to: list[str] = Field(default_factory=list)

    @field_validator("id")
    @classmethod
    def valid_id(cls, v: str) -> str:
        v = str(v)
        if not ID_RE.fullmatch(v):
            raise ValueError(f"must be 4-char [a-z0-9], got: {v!r}")
        return v

    @field_validator("category")
    @classmethod
    def valid_category(cls, v: str) -> str:
        if v not in KNOWN_CATEGORIES:
            raise ValueError(
                f"unknown category {v!r}; known: {sorted(KNOWN_CATEGORIES)}. "
                "Add new categories to KNOWN_CATEGORIES in this script "
                "and to DESIGN_DOCS_GUIDELINES.md"
            )
        return v

    @field_validator("status")
    @classmethod
    def valid_status(cls, v: str) -> str:
        allowed = {"draft", "review", "stable", "deprecated"}
        if v not in allowed:
            raise ValueError(f"must be one of {sorted(allowed)}, got: {v!r}")
        return v

    @field_validator("created", "updated")
    @classmethod
    def valid_date(cls, v) -> str:
        v = str(v)
        try:
            date.fromisoformat(v)
        except (ValueError, TypeError):
            raise ValueError(f"must be ISO date (YYYY-MM-DD), got: {v!r}")
        return v

    @field_validator("tags", "relates_to", "depends_on", "expands", "similar_to", mode="before")
    @classmethod
    def coerce_none_to_list(cls, v):
        """YAML 'tags:' with no value parses to None."""
        return v if v is not None else []

    @field_validator("tech", mode="before")
    @classmethod
    def validate_tech(cls, v):
        if v is None:
            return []
        if not isinstance(v, list):
            raise ValueError("tech must be a list")
        for item in v:
            if isinstance(item, dict):
                if "name" not in item:
                    raise ValueError(f"tech entry missing 'name': {item}")
            else:
                raise ValueError(f"tech entry must be a dict with 'name', got: {type(item)}")
        return v

    @field_validator("relates_to", "depends_on", "expands", "similar_to")
    @classmethod
    def valid_ref_ids(cls, v: list[str]) -> list[str]:
        for ref in v:
            ref = str(ref)
            if not ID_RE.fullmatch(ref):
                raise ValueError(f"ref ID must be 4-char [a-z0-9], got: {ref!r}")
        return [str(r) for r in v]

    @model_validator(mode="after")
    def updated_gte_created(self) -> Self:
        try:
            c = date.fromisoformat(self.created)
            u = date.fromisoformat(self.updated)
            if u < c:
                raise ValueError(f"updated ({self.updated}) < created ({self.created})")
        except (ValueError, TypeError):
            pass  # date format errors already caught by field validators
        return self


# ── Index + cross-reference validation ────────────────────────────────────────

def build_id_index(root: Path) -> dict[str, Path]:
    index: dict[str, Path] = {}
    for md_file in sorted(root.rglob("*.md")):
        if md_file.name == "DESIGN_DOCS_GUIDELINES.md":
            continue
        try:
            post = frontmatter.load(str(md_file))
            doc_id = post.metadata.get("id")
            if doc_id:
                index[str(doc_id)] = md_file
        except Exception:
            pass
    return index


def validate_file(md_file: Path, root: Path, id_index: dict[str, Path]) -> list[str]:
    errors: list[str] = []

    # Check filename format
    fname_match = FILENAME_RE.match(md_file.name)

    # Parse YAML
    try:
        raw = md_file.read_text()
        if raw.startswith("---"):
            parts = raw.split("---", 2)
            if len(parts) < 3:
                errors.append("Missing closing '---' for front matter block")
                return errors
        post = frontmatter.load(str(md_file))
    except yaml.YAMLError as exc:
        return [f"YAML parse error: {exc}"]
    except Exception as exc:
        return [f"Load error: {exc}"]

    if not post.metadata:
        errors.append("No YAML front matter found")
        return errors

    # Schema validation
    try:
        doc = DocFrontmatter(**post.metadata)
    except ValidationError as exc:
        for err in exc.errors():
            loc = " -> ".join(str(l) for l in err["loc"])
            errors.append(f"[{loc}] {err['msg']}")
        return errors

    # Filename ↔ front matter consistency
    if fname_match:
        fn_category, fn_slug, fn_id = fname_match.groups()
        if fn_id != doc.id:
            errors.append(f"Filename ID '{fn_id}' != front matter id '{doc.id}'")
        if fn_category != doc.category:
            errors.append(f"Filename prefix '{fn_category}' != category '{doc.category}'")
    else:
        if md_file.name != "DESIGN_DOCS_GUIDELINES.md":
            errors.append(
                f"Filename doesn't match pattern '{{category}}-{{slug}}-{{id}}.md': {md_file.name}"
            )

    # Cross-reference validation
    for field_name in ("relates_to", "depends_on", "expands", "similar_to"):
        for ref_id in getattr(doc, field_name):
            if str(ref_id) not in id_index:
                errors.append(f"{field_name}: referenced ID '{ref_id}' not found in any doc")

    return errors


def main(root_dir: str = "docs/design") -> int:
    root = Path(root_dir).resolve()
    if not root.is_dir():
        print(f"Error: {root} is not a directory")
        return 2

    md_files = sorted(
        f for f in root.rglob("*.md")
        if f.name != "DESIGN_DOCS_GUIDELINES.md"
    )

    if not md_files:
        print(f"No markdown files found in {root}")
        return 0

    print(f"Scanning {len(md_files)} design doc(s) in {root}...")
    id_index = build_id_index(root)
    print(f"  {len(id_index)} document(s) with IDs indexed.\n")

    # Check for duplicate IDs
    seen_ids: dict[str, list[Path]] = {}
    for doc_id, path in id_index.items():
        seen_ids.setdefault(doc_id, []).append(path)

    total_errors = 0
    for doc_id, paths in seen_ids.items():
        if len(paths) > 1:
            print(f"DUPLICATE ID '{doc_id}':")
            for p in paths:
                print(f"  {p.relative_to(root)}")
            total_errors += 1

    for md_file in md_files:
        errors = validate_file(md_file, root, id_index)
        if errors:
            print(f"FAIL: {md_file.relative_to(root)}")
            for e in errors:
                print(f"  {e}")
            print()
            total_errors += len(errors)

    if total_errors == 0:
        print("All files passed validation.")
        return 0
    else:
        print(f"{total_errors} error(s) found.")
        return 1


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "docs/design"
    sys.exit(main(root))

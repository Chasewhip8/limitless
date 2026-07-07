---
name: document-creation
description: Always load this skill when creating a document, brief, report, or polished PDF — including Sphere-branded documents ("create a Sphere document") or turning markdown, notes, or research into a finished document artifact
---

# Document Creation

Documents are durable artifact workspaces compiled to PDF with Typst. Everything is source-first: edit `main.typ`, compile, inspect the PDF, iterate.

## Tools

- `artifact_templates_list` — discover built-in templates and their files.
- `artifact_template_read` — read template source inline; never create a throwaway artifact just to read one.
- `artifact_create` — create the workspace: `kind: "document"`, `template: <name>`, `title: <title>`.
- `typst_compile` — compile the artifact to `dist/<slug>.pdf`.
- `artifact_list` — find existing document artifacts before creating duplicates.

## Templates

- `brief` — plain, unbranded prose document. Default for "create a document / brief / report".
- `sphere` — Sphere-branded institutional starter. Use for "Sphere document", "Sphere-branded", or any Sphere audience.
- `sphere-showcase` — complete Sphere example document. Never ship it; read it as the authoring reference.

## Workflow

1. Pick the template; check `artifact_list` if the user may mean an existing document.
2. For Sphere documents, read the API index at the top of `sphere.typ` and crib page patterns from `sphere-showcase` `main.typ` via `artifact_template_read`.
3. `artifact_create`, then edit `main.typ` inside the returned artifact path. Drop images and data files under `assets/`.
4. Structure by pages, not by source headings: cover → executive summary → one page per major section → risks → contact, with one idea and a handful of components per page.
5. Compress source material into components instead of transcribing prose. In Sphere documents: metrics → `sphere-metric-strip`; tables → `sphere-data-table`; comparisons → `sphere-comparison-matrix`; processes → `sphere-flow` or `sphere-roadmap`; recommendations → `sphere-card(kind: "decision")`; risks → `kind: "warning"`.
6. In Sphere documents, register evidence: declare each source once with `sphere-source`, pass `source:` on every metric, chart, and table, and end with `sphere-lint()` — drive missing sources to zero.
7. `typst_compile`, then Read the compiled PDF and inspect every page for overflow, cramped or half-empty pages, and unreadable labels. Iterate until it reads as a finished document.
8. Deliver the `dist/` PDF path with a one-line summary of the page structure.

## Do Not

- Ship showcase copy, placeholder metrics, or lorem content as real material.
- Pour markdown verbatim into cards or write walls of prose inside components.
- Leave Sphere charts, tables, or KPIs without a `source:`.
- Declare the document done without compiling and visually inspecting the PDF.

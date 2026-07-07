---
name: document-creation
description: Always load this skill when creating a document, brief, report, or polished PDF — including Sphere-branded documents ("create a Sphere document") or turning markdown, notes, or research into a finished document artifact
---

# Document Creation

You can produce finished, compiled PDF documents. A document is a self-contained artifact workspace: Typst source plus everything it needs (framework modules, fonts, assets) copied into `.limitless/artifacts/<slug>/`. `main.typ` is the document, `assets/` holds images and data files, and compiling writes `dist/<slug>.pdf`. Compiled PDFs can be opened with Read, so you can see exactly what the reader will see.

## Tools

- `artifact_templates_list` — the available templates, their metadata, and full file listings.
- `artifact_template_read` — read any template file inline (`template`, `file`); no artifact needed to study a template.
- `artifact_create` — instantiate a workspace from a template (`kind: "document"`, `template`, `title`, optional `slug`).
- `typst_compile` — compile an artifact's `main.typ` (or another root `.typ` entry) to `dist/<slug>.pdf`.
- `artifact_list` — every artifact workspace already in the project.

## Templates

- `brief` — plain, unbranded prose document.
- `sphere` — Sphere-branded institutional starter on the Sphere framework.
- `sphere-showcase` — a complete, realistic Sphere document exercising every component. It exists to be read as a reference; its figures are illustrative, never shipped as content.

"Create a Sphere document" means the `sphere` template; a plain "document", "brief", or "report" means `brief`.

## The Sphere Framework

`sphere.typ` opens with an index of the entire API. What it gives you:

- Document skeleton: `sphere-document`, `sphere-cover`, `sphere-page` — page chrome, typography, and running footers are handled.
- Layout: `sphere-grid` and `sphere-two-column` measure their cells and stretch cards to equal heights per row automatically.
- Components: semantic cards (base, note, decision, warning, code), KPI strips, bar and column charts, data tables, comparison matrices, flow and system diagrams, roadmaps, proof grids, quotes, badges, and logo pills.
- Evidence: declare sources once with `sphere-source`, attach `source:` to metrics, charts, and tables, cite inline with `sphere-cite`, and `sphere-lint()` renders a QA page auditing coverage.
- Page templates for common layouts: overview, KPI dashboard, comparison, architecture, proof grid, roadmap, and contact pages.

Sphere documents read best as pages of a few strong components — compressed evidence rather than transcribed prose.

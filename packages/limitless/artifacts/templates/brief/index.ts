import type { TypstTemplate } from '../../schemas'
import {
	decodeTemplatePathSync,
	type TemplateArtifactEntry,
	type TemplateInstantiationInput,
} from '../types'

export const BRIEF_TEMPLATE: TypstTemplate = {
	name: 'brief',
	description: 'A clean source-first brief for prose, sections, and lightweight figures.',
	defaultEntry: 'main.typ',
	files: ['main.typ', 'assets/', 'dist/'],
	authoring: 'Edit main.typ directly. Add charts, images, and other source material under assets/.',
	dataShape: {
		source: 'main.typ',
		assets: 'assets/',
	},
}

function typstString(value: string): string {
	return JSON.stringify(value)
}

function briefMainTyp(title: string | undefined): string {
	const documentTitle = title ?? 'Untitled Brief'
	return `#let title = ${typstString(documentTitle)}

#set document(title: title)
#set page(margin: (x: 0.85in, y: 0.8in))
#set text(size: 10.5pt)
#set par(justify: true, leading: 0.58em)

#align(center)[
  #text(size: 22pt, weight: "bold")[#title]
  #linebreak()
  #text(size: 11pt, fill: luma(40%))[Draft brief]
]

#v(1em)

#block(fill: luma(96%), inset: 12pt, radius: 4pt)[
  #text(weight: "bold")[Summary]
  #linebreak()
  Draft the core point here. Edit this file directly and add charts or images under #raw("assets/").
]

== Context

Describe the situation, audience, and constraints.

== Recommendation

State the recommended path and why it is the best tradeoff.
`
}

function briefFiles(input: TemplateInstantiationInput): ReadonlyArray<TemplateArtifactEntry> {
	return [
		{ kind: 'directory', path: decodeTemplatePathSync('assets') },
		{ kind: 'directory', path: decodeTemplatePathSync('dist') },
		{ kind: 'text', path: decodeTemplatePathSync('main.typ'), content: briefMainTyp(input.title) },
	]
}

export const briefTemplate = {
	metadata: BRIEF_TEMPLATE,
	files: briefFiles,
} as const

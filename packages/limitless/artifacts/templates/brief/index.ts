import { Schema } from 'effect'
import type { TypstTemplate } from '../../schemas'
import {
	decodeTemplatePathSync,
	type TemplateArtifactEntry,
	type TemplateInstantiationInput,
} from '../types'

export const BRIEF_TEMPLATE: TypstTemplate = {
	name: 'brief',
	description: 'A clean one-page-ready brief with title, subtitle, summary, and sections.',
	defaultEntry: 'main.typ',
	files: ['main.typ', 'data.json', 'assets/', 'dist/'],
	dataShape: {
		title: 'string',
		subtitle: 'string',
		summary: 'string',
		sections: [{ title: 'string', body: 'string' }],
	},
}

const BriefSection = Schema.Struct({
	title: Schema.String,
	body: Schema.String,
})

const BriefData = Schema.Struct({
	title: Schema.String,
	subtitle: Schema.String,
	summary: Schema.String,
	sections: Schema.Array(BriefSection),
})

type BriefData = typeof BriefData.Type

export const BRIEF_MAIN_TYP = `#let data = json("data.json")

#set document(title: data.at("title", default: "Untitled Document"))
#set page(margin: (x: 0.85in, y: 0.8in))
#set text(size: 10.5pt)
#set par(justify: true, leading: 0.58em)

#let title = data.at("title", default: "Untitled Document")
#let subtitle = data.at("subtitle", default: "")
#let summary = data.at("summary", default: "")
#let sections = data.at("sections", default: ())

#align(center)[
  #text(size: 22pt, weight: "bold")[#title]
  #if subtitle != "" [
    #linebreak()
    #text(size: 11pt, fill: luma(40%))[#subtitle]
  ]
]

#v(1em)

#if summary != "" [
  #block(fill: luma(96%), inset: 12pt, radius: 4pt)[
    #text(weight: "bold")[Summary]
    #linebreak()
    #summary
  ]
]

#for section in sections [
  #v(0.7em)
  == #section.at("title", default: "Section")
  #section.at("body", default: "")
]
`

function defaultBriefData(title: string | undefined): BriefData {
	return {
		title: title ?? 'Untitled Document',
		subtitle: '',
		summary:
			'Draft the core point here. Edit data.json for structured content or main.typ for full Typst control.',
		sections: [
			{
				title: 'Context',
				body: 'Describe the situation, audience, and constraints.',
			},
			{
				title: 'Recommendation',
				body: 'State the recommended path and why it is the best tradeoff.',
			},
		],
	}
}

function briefFiles(input: TemplateInstantiationInput): ReadonlyArray<TemplateArtifactEntry> {
	return [
		{ kind: 'directory', path: decodeTemplatePathSync('assets') },
		{ kind: 'directory', path: decodeTemplatePathSync('dist') },
		{ kind: 'text', path: decodeTemplatePathSync('main.typ'), content: BRIEF_MAIN_TYP },
		{
			kind: 'json',
			path: decodeTemplatePathSync('data.json'),
			value: defaultBriefData(input.title),
		},
	]
}

export const briefTemplate = {
	metadata: BRIEF_TEMPLATE,
	files: briefFiles,
} as const

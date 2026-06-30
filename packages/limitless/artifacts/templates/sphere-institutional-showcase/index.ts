import {
	renderSphereTypstTemplate,
	SPHERE_ASSETS,
	SPHERE_TYP,
	sphereTypstSource,
} from '../../frameworks/sphere'
import type { TypstTemplate } from '../../schemas'
import {
	decodeTemplatePathSync,
	type TemplateArtifactEntry,
	type TemplateInstantiationInput,
} from '../types'

export const SPHERE_INSTITUTIONAL_SHOWCASE_TEMPLATE: TypstTemplate = {
	name: 'sphere-institutional-showcase',
	description:
		'Complete Sphere institutional showcase with branded SDK primitives, charts, tables, diagrams, proof grids, and dark analytical pages.',
	defaultEntry: 'main.typ',
	files: ['main.typ', 'sphere.typ', 'assets/', 'dist/'],
	authoring:
		'Use this as the full-featured reference document. Edit main.typ for copy/data and promote stable reusable patterns into sphere.typ.',
	dataShape: {
		source: 'main.typ',
		framework: 'sphere.typ',
		assets: 'assets/',
		features: [
			'cover',
			'typography',
			'cards',
			'kpis',
			'bar-chart',
			'column-chart',
			'step-chart',
			'tables',
			'comparison-matrix',
			'process-diagram',
			'proof-grid',
			'dark-mode-analysis',
			'roadmap',
		],
	},
}

const MAIN_TYP = sphereTypstSource(
	'./main.typ',
	'sphere-institutional-showcase-main.typ',
	import.meta.url,
)

function files(input: TemplateInstantiationInput): ReadonlyArray<TemplateArtifactEntry> {
	return [
		{ kind: 'directory', path: decodeTemplatePathSync('assets') },
		{ kind: 'directory', path: decodeTemplatePathSync('assets/fonts') },
		{ kind: 'directory', path: decodeTemplatePathSync('dist') },
		{
			kind: 'binary',
			path: decodeTemplatePathSync('assets/sphere-cover.png'),
			content: SPHERE_ASSETS.cover,
		},
		{
			kind: 'binary',
			path: decodeTemplatePathSync('assets/sphere-cover-print.png'),
			content: SPHERE_ASSETS.coverPrint,
		},
		{
			kind: 'binary',
			path: decodeTemplatePathSync('assets/sphere-page.png'),
			content: SPHERE_ASSETS.page,
		},
		{
			kind: 'binary',
			path: decodeTemplatePathSync('assets/sphere-logo.svg'),
			content: SPHERE_ASSETS.logo,
		},
		{
			kind: 'binary',
			path: decodeTemplatePathSync('assets/fonts/Inter-Variable.ttf'),
			content: SPHERE_ASSETS.interVariable,
		},
		{
			kind: 'binary',
			path: decodeTemplatePathSync('assets/fonts/Inter-Italic-Variable.ttf'),
			content: SPHERE_ASSETS.interItalicVariable,
		},
		{
			kind: 'binary',
			path: decodeTemplatePathSync('assets/fonts/OFL.txt'),
			content: SPHERE_ASSETS.interLicense,
		},
		{ kind: 'text', path: decodeTemplatePathSync('sphere.typ'), content: SPHERE_TYP },
		{
			kind: 'text',
			path: decodeTemplatePathSync('main.typ'),
			content: renderSphereTypstTemplate(
				MAIN_TYP,
				{ title: input.title, variant: 'sphere-institutional' },
				'Sphere Institutional Showcase',
			),
		},
	]
}

export const sphereInstitutionalShowcaseTemplate = {
	metadata: SPHERE_INSTITUTIONAL_SHOWCASE_TEMPLATE,
	files,
} as const

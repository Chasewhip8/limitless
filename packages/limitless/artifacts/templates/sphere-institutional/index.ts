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

export const SPHERE_INSTITUTIONAL_TEMPLATE: TypstTemplate = {
	name: 'sphere-institutional',
	description:
		'Sphere institutional document framework with cover, style page, overview components, and editable Typst source.',
	defaultEntry: 'main.typ',
	files: ['main.typ', 'sphere.typ', 'assets/', 'dist/'],
	authoring:
		'Edit main.typ directly and use sphere.typ components for consistent Sphere-branded pages.',
	dataShape: {
		source: 'main.typ',
		framework: 'sphere.typ',
		assets: 'assets/',
	},
}

const MAIN_TYP = sphereTypstSource('./main.typ', 'sphere-institutional-main.typ', import.meta.url)

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
				'Document Title',
			),
		},
	]
}

export const sphereInstitutionalTemplate = {
	metadata: SPHERE_INSTITUTIONAL_TEMPLATE,
	files,
} as const

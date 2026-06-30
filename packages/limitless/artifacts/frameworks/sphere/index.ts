import { readFileSync } from 'node:fs'

function assetBytes(fileName: string): Uint8Array {
	return readFileSync(new URL(`./assets/${fileName}`, import.meta.url))
}

function readText(url: URL): string {
	return readFileSync(url, 'utf8')
}

export const SPHERE_ASSETS = {
	cover: assetBytes('cover.png'),
	coverPrint: assetBytes('cover-print.png'),
	page: assetBytes('page.png'),
	logo: assetBytes('sphere-logo.svg'),
	interVariable: assetBytes('fonts/Inter-Variable.ttf'),
	interItalicVariable: assetBytes('fonts/Inter-Italic-Variable.ttf'),
	interLicense: assetBytes('fonts/OFL.txt'),
} as const

export type SphereVariant = 'sphere-institutional' | 'sphere-institutional-print'

export function sphereTypstSource(
	sourcePath: string,
	bundledFileName: string,
	baseUrl: string,
): string {
	try {
		return readText(new URL(sourcePath, baseUrl))
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return readText(new URL(`./${bundledFileName}`, import.meta.url))
		}
		throw error
	}
}

function typstString(value: string): string {
	return JSON.stringify(value)
}

export function renderSphereTypstTemplate(
	source: string,
	input: { readonly title?: string | undefined; readonly variant: SphereVariant },
	defaultTitle: string,
): string {
	return source
		.replaceAll('"../../frameworks/sphere/sphere.typ"', '"sphere.typ"')
		.replaceAll('"../sphere/sphere.typ"', '"sphere.typ"')
		.replaceAll('"__SPHERE_DOCUMENT_TITLE__"', typstString(input.title ?? defaultTitle))
		.replaceAll('"__SPHERE_VARIANT__"', typstString(input.variant))
}

export const SPHERE_TYP = sphereTypstSource('./sphere.typ', 'sphere.typ', import.meta.url)

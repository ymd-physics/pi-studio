import chinese from './zh-CN.json'

export type Language = 'en' | 'zh-CN'
const translations: Readonly<Record<string, string>> = chinese
export function uiText(language: Language = 'en') {
  return language === 'zh-CN' ? zh : en
}
const en = (text: string) => text
const zh = (text: string) => Object.hasOwn(translations, text) ? translations[text] : text

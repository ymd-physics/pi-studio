import chinese from './zh-CN.json'

export type Language = 'en' | 'zh-CN'
const translations: Readonly<Record<string, string>> = chinese
export function uiText(language: Language = 'en') {
  return language === 'zh-CN' ? zh : en
}
type Values = Record<string, string | number>
function format(text: string, values?: Values) {
  return values ? text.replace(/\{(\w+)\}/g, (key, name: string) => Object.hasOwn(values, name) ? String(values[name]) : key) : text
}
const en = (text: string, values?: Values) => format(text, values)
const zh = (text: string, values?: Values) => format(Object.hasOwn(translations, text) ? translations[text] : text, values)

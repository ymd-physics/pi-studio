import { createContext, useContext } from 'react'
import { uiText, type Language } from '../../../../packages/shared/language'

export const LanguageContext = createContext<Language>('en')
export const useUiText = () => uiText(useContext(LanguageContext))

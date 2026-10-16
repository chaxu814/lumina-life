import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS },
    },
    fallbackLng: 'zh-CN',
    // 🌐 默认语言固定为简体中文：只读取用户显式选择（localStorage），
    //    不再跟随 navigator.language，避免英文系统用户首次启动时界面变成英文。
    detection: {
      order: ['localStorage'],
      caches: ['localStorage'],
      lookupLocalStorage: 'lumina_lang',
    },
    interpolation: {
      escapeValue: false,
    },
  })

// 补丁：让 setLng 支持 'zh' / 'en' 简写
const origChangeLanguage = i18n.changeLanguage.bind(i18n)
i18n.changeLanguage = ((lng: string) => {
  const normalized = lng === 'en' ? 'en-US' : lng === 'zh' ? 'zh-CN' : lng
  return origChangeLanguage(normalized)
}) as typeof i18n.changeLanguage

export default i18n

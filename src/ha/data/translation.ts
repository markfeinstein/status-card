export type TranslationCategory = string;

export interface FrontendLocaleData {
  language: string;
  number_format?: string;
  time_format?: string;
  date_format?: string;
  first_weekday?: number;
}

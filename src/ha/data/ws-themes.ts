export interface Themes {
  default_theme?: string;
  default_dark_theme?: string | null;
  themes?: Record<string, Record<string, string>>;
  darkMode?: boolean;
  [key: string]: unknown;
}

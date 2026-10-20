/** Una tienda del App Store en la que se vigila la ficha. */
export interface AsoStoreConfig {
  id: string;
  /** Código de país de 2 letras en minúsculas (es, mx, us). */
  country: string;
  /** Cabecera X-Apple-Store-Front de la tienda, p. ej. «143454-8,29». */
  storefront: string;
  /** Archivo de la ficha, relativo al repo del proyecto. */
  fichaFile: string;
}

export interface AsoConfig {
  appId: string;
  stores: AsoStoreConfig[];
}

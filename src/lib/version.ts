import pkg from "../../package.json";

/** Segue as publicações do GitHub: bump o `version` do package.json a cada
 *  release, e o app inteiro (rodapé, aviso de abertura) reflete sozinho. */
export const APP_VERSION = pkg.version;

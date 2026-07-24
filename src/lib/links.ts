/** Formulário de feedback/bugs do Alpha — mesmo link em qualquer lugar que o
 *  ofereça (rodapé, aviso de abertura). Um lugar só para trocar quando o
 *  formulário mudar. */
export const FEEDBACK_FORM_URL = "https://forms.gle/bX15FC1XTvHMp6SF8";

/** Repo público onde o roadmap e as releases do Alpha ficam — mesmo repo que
 *  `.github/workflows/release.yml` publica a cada tag `v*`. */
export const REPO_URL = "https://github.com/Lohan-Costa/orbita";

/** Onde o checador de atualização busca os releases (inclui prerelease: o
 *  `/releases/latest` do GitHub IGNORA prerelease, e todo release do Alpha é
 *  marcado como tal — ver release.yml). */
export const REPO_RELEASES_API_URL = "https://api.github.com/repos/Lohan-Costa/orbita/releases";

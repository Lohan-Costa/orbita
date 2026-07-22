# 0006 — O cache em disco é LRU por último USO, não por escrita

**Status:** ativa

**Contexto:** o Órbita guarda em disco duas coisas caras de recalcular: as
formas de onda (`peaks`) e os metadados já lidos (`probe`). Desenhar a waveform
de um clipe exige ler o arquivo INTEIRO — numa diária de Alexa são centenas de
GB e vários minutos. Sem um teto, esse cache cresce sem limite; com um teto, é
preciso decidir o que sai primeiro.

A escolha ingênua é despejar por data de ESCRITA (`mtime` de quando o arquivo de
cache foi gravado). Ela tem um efeito perverso: a waveform que o usuário abre
todo dia foi escrita uma vez, no começo, e vira a mais "antiga" — enquanto a que
ele gerou por engano ontem e nunca mais viu fica. O cache passa a jogar fora
justamente o que está em uso, e o usuário paga a releitura de novo e de novo.

**Decisão:** o despejo é **LRU por último uso**. `peakcache.load()` e
`probecache.load()` dão `touch` (`os.utime`) no arquivo ao acertar o cache, e
`cachedir.enforce_limit()` ordena por `mtime` — que assim significa "última vez
que serviu", não "quando nasceu". O teto é configurável na janela de
Configurações (padrão 5 GB) e o despejo roda depois das escritas, com rédea
curta (uma varredura a cada 10 s no máximo).

`clear()` e `stats()` só enxergam as subpastas que o app gerencia (`peaks/`,
`probe/`), nunca a raiz inteira: o usuário pode apontar o cache para uma pasta
que já tem outras coisas dentro, e nada fora dali pode ser tocado.

**Alternativas consideradas:** despejo por data de escrita (descartada — ver
acima); nenhum teto (descartada — o cache cresce sem limite e o usuário não tem
como saber o que ocupa o disco); cache junto da mídia, como os `.pek` do
Premiere (descartada — o material bruto costuma estar em cartão, HD só de
leitura ou NAS compartilhado, onde escrever ao lado é presunçoso ou impossível).

**Consequência:** todo caminho de LEITURA do cache tem de dar `touch`. Um
`load()` novo que esqueça disso degrada silenciosamente o despejo de volta para
"por escrita" — o teste
`test_touch_na_leitura_salva_o_arquivo_do_despejo` existe para pegar isso.

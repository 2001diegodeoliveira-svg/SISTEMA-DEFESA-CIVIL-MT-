# Snapshot local de dados territoriais e indicadores

Estes arquivos evitam depender do `servicodados.ibge.gov.br` em tempo real
(instável fora do Brasil). São servidos pela CDN da Vercel e usados pelo
mapa, pela gestão e pela página inicial.

| Arquivo | Conteúdo | Fonte |
|---|---|---|
| `malhas/estados.geojson` | limite das 27 UFs | IBGE — Malhas Territoriais (`qualidade=minima`) |
| `malhas/uf-XX.geojson` | municípios de cada UF | IBGE — Malhas Territoriais (`qualidade=minima`) |
| `indicadores.json` | população, área, densidade, urbanização, PIB total/per capita | IBGE — Censo 2022 (SIDRA 4714/9923) e PIB dos Municípios 2023 (SIDRA 5938) |
| `atlas.json` | IDHM e subíndices, esperança de vida, mortalidade infantil, escolarização | Atlas do Desenvolvimento Humano no Brasil 2013 (PNUD/IPEA/FJP — Censo 2010) |

## Como regenerar

```bash
npm run snapshot:ibge
```

O script `scripts/gerar-snapshot-ibge.js` baixa localidades, malhas e os
indicadores do Censo 2022/PIB 2023. Ele só baixa de novo as malhas que
ainda não existem em `geo/malhas/`.

O `atlas.json` é estático (Censo 2010). Para regenerá-lo, baixe a base
`municipal.csv` do Atlas Brasil 2013 e extraia as colunas `IDHM`,
`IDHM_L`, `IDHM_E`, `IDHM_R`, `ESPVIDA`, `MORT1` e `T_FREQ6A14` do ano
2010 para o formato `{ municipios: { "<codigo IBGE>": { ... } } }`.

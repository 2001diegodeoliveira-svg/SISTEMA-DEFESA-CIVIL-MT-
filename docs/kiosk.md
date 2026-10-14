# Modo sala de situação 24h (Fase 7)

Painel kiosk do Mapa Integrado para TVs de plantão.

## Parâmetros de URL (podem combinar)

| Param | Padrão | Efeito |
|---|---|---|
| `?kiosk=1` | off | Esconde menus/painéis, mostra barra do plantão |
| `?giro=SECS` | `90` | Rotação automática por UF (mín 15, máx 1800) |
| `?ufs=MT,SP` | todas | Lista a girar (siglas); vazio = as 27 UFs |
| `?reload=HORAS` | `6` no kiosk, `0` fora | Recarga preventiva preservando a visão |
| `?uf=51` | — | UF inicial (existente) |

Exemplo TV de plantão nacional, giro de 2 min, recarga a cada 8h:

```
https://sgi-protege.vercel.app/mapa.html?kiosk=1&giro=120&reload=8
```

Só MT, sem recarga:

```
.../mapa.html?kiosk=1&ufs=MT&giro=60&reload=0
```

## Comportamento

- Relógio Brasília + UTC sempre visível no topo (fora do kiosk também).
- Rotação usa `selecionarUf` (mesmo caminho do clique manual):
  camadas da UF recarregam; ao fim da lista, recomeça.
- Recarga salva UF, camadas visíveis, centro e zoom em
  `sessionStorage` e restaura após o reload (janela de 12h).
- Tela cheia: botão ⛶ na barra (navegador exige gesto; sem auto).
- Sair: botão ✕ (remove `?kiosk=1`).
- Tema escuro já cobre controles, popups, modais e legenda.
- Service worker (`/sw.js`, cache `sgi-v1`): app shell em
  cache-first; `/api/*` network-first com fallback ao cache.
  **Bump o `CACHE` a cada deploy com mudança no front.**

## Limites honestos

- Sem som em kiosk sem interação prévia (autoplay policy);
  banner visual + som funcionam após qualquer clique.
- Push web exige permissão (botão Ativar notificações).
- TV muito fraca: prefira `?ufs=` curto e giro longo.

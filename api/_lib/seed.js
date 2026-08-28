/* Seed dos alertas curados (server-side) — espelha js/data.js ALERTAS_ATIVOS.
   Usado para popular o store na primeira execução (GET /api/alertas). */

const ALERTAS_SEED = [
  {
    id: 'AL-2026-0341', nivel: 'emergencia', tipo: 'enchente',
    municipio: 'Barão de Melgaço',
    resumo: 'Rio Cuiabá acima da cota de emergência (5,9 m). Famílias ribeirinhas atingidas.',
    descricao: 'O Rio Cuiabá, na régua de Barão de Melgaço, ultrapassou a cota de emergência de 5,8 m às 06h20 desta segunda-feira. A tendência é de elevação lenta nas próximas 48h devido à vazão a jusante de Cuiabá e Várzea Grande.',
    areasAfetadas: ['Comunidade São João', 'Porto Jofre (km 20–45)', 'Estrada Parque Cuiabá–Poconé'],
    orientacoes: [
      'Residentes em áreas ribeirinhas devem buscar abrigo temporário na Escola Estadual de Barão de Melgaço.',
      'Não transitar na Estrada Parque sem autorização — trechos com lâmina d\'água.',
      'Mantenha documentos e medicamentos em local acessível e seco.',
      'Em caso de risco imediato, ligue 199.',
    ],
  },
  {
    id: 'AL-2026-0338', nivel: 'alerta', tipo: 'chuvas_intensas', municipio: 'Sinop',
    resumo: 'Acumulado de 68 mm/24h. Risco de alagamentos em pontos críticos urbanos.',
    descricao: 'Sistema de baixa pressão associado à ZCAS mantém volumes elevados de precipitação sobre o norte do estado. Estações telemétricas registraram 68 mm nas últimas 24h em Sinop, com previsão de mais 40 mm até amanhã.',
    areasAfetadas: ['Bairros Setor Industrial e Jardim Araucária', 'Av. das Itaúbas', 'Região do CPD'],
    orientacoes: [
      'Evite atravessar ruas alagadas a pé ou de veículo — 30 cm de água já movimentam um carro.',
      'Não se abrigue sob árvores durante raios.',
      'Desligue aparelhos elétricos em caso de inundação interna.',
    ],
  },
  {
    id: 'AL-2026-0340', nivel: 'alerta', tipo: 'incendio', municipio: 'Poconé',
    resumo: 'Foco de calor detectado por satélite em zona rural. Risco alto de propagação.',
    descricao: 'Sensoriamento remoto (Programa Queimadas/INPE) identificou foco de calor de alta intensidade a 12 km da zona urbana de Poconé. Umidade relativa abaixo de 30% e ventos de 25 km/h favorecem a propagação.',
    areasAfetadas: ['Fazendas no entorno do Estrada Park Transpantaneira (km 0–12)', 'Zona rural de Poconé'],
    orientacoes: [
      'Produtores rurais devem abrir aceiros e evitar qualquer uso do fogo.',
      'Reporte novas frentes de fogo pelo 199 ou pelo aplicativo Defesa Civil MT.',
      'Moradores de áreas com fumaça densa: use máscaras e evite atividades ao ar livre.',
    ],
  },
  {
    id: 'AL-2026-0337', nivel: 'alerta', tipo: 'enchente', municipio: 'Barra do Garças',
    resumo: 'Rio Araguaia em cota de alerta (6,2 m) com tendência de subida.',
    descricao: 'A régua fluvial do Rio Araguaia em Barra do Garças registrou 6,2 m, ultrapassando a cota de alerta de 6,0 m. Monitoramento contínuo a cada hora; próxima revisão técnica prevista para as 18h.',
    areasAfetadas: ['Orla fluvial', 'Colônia de pescadores Z-4', 'Balneário municipal'],
    orientacoes: [
      'Embarcações devem ser atracadas com reforço de amarração.',
      'Evite banho e atividades aquáticas no rio durante o período de alerta.',
      'Comerciantes da orla devem retirar mercadorias do piso térreo.',
    ],
  },
  {
    id: 'AL-2026-0335', nivel: 'atencao', tipo: 'vento', municipio: 'Rondonópolis',
    resumo: 'Rajadas de vento acima de 60 km/h previstas para a tarde.',
    descricao: 'Modelos indicam linha de instabilidade com rajadas entre 60 e 75 km/h no período da tarde, podendo derrubar galhos, placas e estruturas provisórias.',
    areasAfetadas: ['Todo o perímetro urbano', 'Distrito de Boa Esperança'],
    orientacoes: [
      'Retire objetos soltos de sacadas e telhados.',
      'Estacione veículos longe de árvores e placas.',
      'Eventos ao ar livre devem adotar plano de contingência.',
    ],
  },
  {
    id: 'AL-2026-0332', nivel: 'atencao', tipo: 'estiagem', municipio: 'Alta Floresta',
    resumo: 'Índice de umidade do solo crítico. Restrição de queima controlada.',
    descricao: 'Déficit hídrico acumulado de 90 dias coloca o município em situação de atenção para estiagem, com impacto previsto na agricultura familiar e risco crescente de incêndios.',
    areasAfetadas: ['Área rural — todos os distritos'],
    orientacoes: [
      'Uso racional da água para consumo humano prioritário.',
      'Proibida a queima controlada de resíduos até nova avaliação.',
      'Produtores podem solicitar avaliação técnica via Defesa Civil Municipal.',
    ],
  },
];

module.exports = { ALERTAS_SEED };

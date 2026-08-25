/* ============================================================
   Dados operacionais — Defesa Civil MT
   Estrutura pronta para substituição por API do backend:
   GET /api/alertas  →  mesmo formato de objeto abaixo.
   ============================================================ */

const NIVEIS = {
    atencao:     { label: 'Atenção',    cor: '#eab308', icone: 'fa-triangle-exclamation' },
    alerta:      { label: 'Alerta',     cor: '#f9631c', icone: 'fa-circle-exclamation' },
    emergencia:  { label: 'Emergência', cor: '#ef4444', icone: 'fa-tower-broadcast' },
};

const TIPOS = {
    enchente:        { label: 'Enchente / Inundação', icone: 'fa-house-water' },
    chuvas_intensas: { label: 'Chuvas Intensas',      icone: 'fa-cloud-showers-heavy' },
    incendio:        { label: 'Incêndio Florestal',   icone: 'fa-fire' },
    estiagem:        { label: 'Estiagem / Seca',      icone: 'fa-sun-plant-wilt' },
    vento:           { label: 'Vendaval',             icone: 'fa-wind' },
    granizo:         { label: 'Granizo',              icone: 'fa-cloud-hail' },
};

const ALERTAS_ATIVOS = [
    {
        id: 'AL-2026-0341',
        nivel: 'emergencia',
        tipo: 'enchente',
        municipio: 'Barão de Melgaço',
        resumo: 'Rio Cuiabá acima da cota de emergência (5,9 m). Famílias ribeirinhas atingidas.',
        descricao: 'O Rio Cuiabá, na régua de Barão de Melgaço, ultrapassou a cota de emergência de 5,8 m às 06h20 desta segunda-feira. A tendência é de elevação lenta nas próximas 48h devido à vazão a jusante de Cuiabá e Várzea Grande.',
        emitidoEm: '2026-08-23T07:00',
        validoAte: '2026-08-27T12:00',
        areasAfetadas: ['Comunidade São João', 'Porto Jofre (km 20–45)', 'Estrada Parque Cuiabá–Poconé'],
        orientacoes: [
            'Residentes em áreas ribeirinhas devem buscar abrigo temporário na Escola Estadual de Barão de Melgaço.',
            'Não transitar na Estrada Parque sem autorização — trechos com lâmina d\'água.',
            'Mantenha documentos e medicamentos em local acessível e seco.',
            'Em caso de risco imediato, ligue 199.',
        ],
    },
    {
        id: 'AL-2026-0338',
        nivel: 'alerta',
        tipo: 'chuvas_intensas',
        municipio: 'Sinop',
        resumo: 'Acumulado de 68 mm/24h. Risco de alagamentos em pontos críticos urbanos.',
        descricao: 'Sistema de baixa pressão associado à ZCAS mantém volumes elevados de precipitação sobre o norte do estado. Estações telemétricas registraram 68 mm nas últimas 24h em Sinop, com previsão de mais 40 mm até amanhã.',
        emitidoEm: '2026-08-22T18:45',
        validoAte: '2026-08-25T23:59',
        areasAfetadas: ['Bairros Setor Industrial e Jardim Araucária', 'Av. das Itaúbas', 'Região do CPD'],
        orientacoes: [
            'Evite atravessar ruas alagadas a pé ou de veículo — 30 cm de água já movimentam um carro.',
            'Não se abrigue sob árvores durante raios.',
            'Desligue aparelhos elétricos em caso de inundação interna.',
        ],
    },
    {
        id: 'AL-2026-0340',
        nivel: 'alerta',
        tipo: 'incendio',
        municipio: 'Poconé',
        resumo: 'Foco de calor detectado por satélite em zona rural. Risco alto de propagação.',
        descricao: 'Sensoriamento remoto (Programa Queimadas/INPE) identificou foco de calor de alta intensidade a 12 km da zona urbana de Poconé. Umidade relativa abaixo de 30% e ventos de 25 km/h favorecem a propagação.',
        emitidoEm: '2026-08-23T09:15',
        validoAte: '2026-08-26T18:00',
        areasAfetadas: ['Fazendas no entorno do Estrada Park Transpantaneira (km 0–12)', 'Zona rural de Poconé'],
        orientacoes: [
            'Produtores rurais devem abrir aceiros e evitar qualquer uso do fogo.',
            'Reporte novas frentes de fogo pelo 199 ou pelo aplicativo Defesa Civil MT.',
            'Moradores de áreas com fumaça densa: use máscaras e evite atividades ao ar livre.',
        ],
    },
    {
        id: 'AL-2026-0337',
        nivel: 'alerta',
        tipo: 'enchente',
        municipio: 'Barra do Garças',
        resumo: 'Rio Araguaia em cota de alerta (6,2 m) com tendência de subida.',
        descricao: 'A régua fluvial do Rio Araguaia em Barra do Garças registrou 6,2 m, ultrapassando a cota de alerta de 6,0 m. Monitoramento contínuo a cada hora; próxima revisão técnica prevista para as 18h.',
        emitidoEm: '2026-08-22T12:00',
        validoAte: '2026-08-28T12:00',
        areasAfetadas: ['Orla fluvial', 'Colônia de pescadores Z-4', 'Balneário municipal'],
        orientacoes: [
            'Embarcações devem ser atracadas com reforço de amarração.',
            'Evite banho e atividades aquáticas no rio durante o período de alerta.',
            'Comerciantes da orla devem retirar mercadorias do piso térreo.',
        ],
    },
    {
        id: 'AL-2026-0335',
        nivel: 'atencao',
        tipo: 'vento',
        municipio: 'Rondonópolis',
        resumo: 'Rajadas de vento acima de 60 km/h previstas para a tarde.',
        descricao: 'Modelos indicam linha de instabilidade com rajadas entre 60 e 75 km/h no período da tarde, podendo derrubar galhos, placas e estruturas provisórias.',
        emitidoEm: '2026-08-23T10:30',
        validoAte: '2026-08-23T23:59',
        areasAfetadas: ['Todo o perímetro urbano', 'Distrito de Boa Esperança'],
        orientacoes: [
            'Retire objetos soltos de sacadas e telhados.',
            'Estacione veículos longe de árvores e placas.',
            'Eventos ao ar livre devem adotar plano de contingência.',
        ],
    },
    {
        id: 'AL-2026-0332',
        nivel: 'atencao',
        tipo: 'estiagem',
        municipio: 'Alta Floresta',
        resumo: 'Índice de umidade do solo crítico. Restrição de queima controlada.',
        descricao: 'Déficit hídrico acumulado de 90 dias coloca o município em situação de atenção para estiagem, com impacto previsto na agricultura familiar e risco crescente de incêndios.',
        emitidoEm: '2026-08-20T08:00',
        validoAte: '2026-09-05T23:59',
        areasAfetadas: ['Área rural — todos os distritos'],
        orientacoes: [
            'Uso racional da água para consumo humano prioritário.',
            'Proibida a queima controlada de resíduos até nova avaliação.',
            'Produtores podem solicitar avaliação técnica via Defesa Civil Municipal.',
        ],
    },
];

/* ============================================================
   Rede de monitoramento DC (ilustrativa) — compartilhada entre
   home, mapa e alertas. Formato pronto p/ API do backend.
   ============================================================ */
const TIPO_ESTACAO = {
    rain:    { cor: '#f9631c', icone: 'fa-cloud-rain',        rotulo: 'Pluviômetro' },
    river:   { cor: '#38bdf8', icone: 'fa-water',             rotulo: 'Régua fluvial' },
    fire:    { cor: '#ef4444', icone: 'fa-fire',              rotulo: 'Foco de calor' },
    shelter: { cor: '#34d399', icone: 'fa-house-chimney-user',rotulo: 'Abrigo' },
};

const ESTACOES_DC = [
    { name: 'Pluviômetro Cuiabá — Centro', city: 'Cuiabá', lat: -15.601, lng: -56.097, type: 'rain', val: '52 mm/24h', status: 'Atenção' },
    { name: 'Pluviômetro Sinop', city: 'Sinop', lat: -11.860, lng: -55.502, type: 'rain', val: '68 mm/24h', status: 'Alerta' },
    { name: 'Pluviômetro Rondonópolis', city: 'Rondonópolis', lat: -16.470, lng: -54.635, type: 'rain', val: '18 mm/24h', status: 'Normal' },
    { name: 'Régua Rio Cuiabá — Porto', city: 'Cuiabá', lat: -15.591, lng: -56.086, type: 'river', val: '4,8 m', status: 'Atenção' },
    { name: 'Régua Rio Araguaia', city: 'Barra do Garças', lat: -15.884, lng: -52.259, type: 'river', val: '6,2 m', status: 'Alerta' },
    { name: 'Régua Rio Cuiabá — Barão de Melgaço', city: 'Barão de Melgaço', lat: -16.194, lng: -55.968, type: 'river', val: '5,9 m', status: 'Emergência' },
    { name: 'Foco de calor — zona rural', city: 'Poconé', lat: -16.257, lng: -56.622, type: 'fire', val: 'detecção por satélite', status: 'Alerta' },
    { name: 'Abrigo temporário', city: 'Cuiabá', lat: -15.610, lng: -56.070, type: 'shelter', val: '120 vagas', status: 'Operacional' },
];

/* Perfis de acesso (item 9 da proposta) */
const PERFIS = {
    comum:     { label: 'Usuário comum',          desc: 'Camadas públicas, áreas de interesse e alertas da sua região', icone: 'fa-user' },
    avancado:  { label: 'Usuário avançado',       desc: 'Painéis analíticos, validação de ocorrências e relatórios',    icone: 'fa-user-gear' },
    admin:     { label: 'Administrador estadual', desc: 'Fontes/camadas, regras de alerta, perfis e auditoria',         icone: 'fa-user-shield' },
    municipal: { label: 'Gestor municipal',       desc: 'Acesso restrito ao seu território, confirmação e evidências',  icone: 'fa-city' },
};

const ordemNivel = { emergencia: 0, alerta: 1, atencao: 2 };

/* ============================================================
   Portais oficiais de dados (item 6 da proposta técnica)
   ============================================================ */
const PORTAIS_OFICIAIS = [
    { nome: 'IBGE — Malhas Territoriais', url: 'https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais/15774-malhas.html', uso: 'Limites estaduais e municipais' },
    { nome: 'INPE — BDQueimadas', url: 'https://data.inpe.br/queimadas/bdqueimadas/', uso: 'Focos de calor oficiais' },
    { nome: 'NASA FIRMS', url: 'https://firms.modaps.eosdis.nasa.gov/map/', uso: 'Detecções MODIS/VIIRS em tempo real' },
    { nome: 'FIRMS — API de Dados', url: 'https://firms.modaps.eosdis.nasa.gov/api/area/', uso: 'API de área (requer MAP_KEY gratuito)' },
    { nome: 'CENSIPAM — Painel do Fogo', url: 'https://panorama.sipam.gov.br/painel-do-fogo', uso: 'Eventos de fogo' },
    { nome: 'INMET', url: 'https://portal.inmet.gov.br/', uso: 'Estações, previsão e avisos' },
    { nome: 'CEMADEN', url: 'https://mapainterativo.cemaden.gov.br/', uso: 'Chuva e monitoramento' },
    { nome: 'SGB — SACE', url: 'https://www.sgb.gov.br/sace/', uso: 'Hidrologia e secas' },
    { nome: 'CNUC/MMA', url: 'https://www.mma.gov.br/uc/conservacao/,', uso: 'Unidades de Conservação' },
    { nome: 'FUNAI — Terras Indígenas', url: 'https://www.gov.br/funai/pt-br/assuntos/terras-indigenas', uso: 'Geoprocessamento TI' },
];

/* Fonte oficial recomendada por tipo de alerta (link contextual nos cards) */
const TIPO_FONTES = {
    incendio: [
        { nome: 'INPE BDQueimadas', url: 'https://data.inpe.br/queimadas/bdqueimadas/' },
        { nome: 'NASA FIRMS', url: 'https://firms.modaps.eosdis.nasa.gov/map/' },
    ],
    enchente: [
        { nome: 'SGB/SACE — Boletins hidrológicos', url: 'https://www.sgb.gov.br/sace/' },
    ],
    chuvas_intensas: [
        { nome: 'CEMADEN — Mapa interativo', url: 'https://mapainterativo.cemaden.gov.br/' },
        { nome: 'INMET — Avisos meteorológicos', url: 'https://alertas2.inmet.gov.br/' },
    ],
    estiagem: [
        { nome: 'SGB/SACE — Monitor de secas', url: 'https://www.sgb.gov.br/sace/' },
    ],
    vento: [
        { nome: 'INMET — Avisos meteorológicos', url: 'https://alertas2.inmet.gov.br/' },
    ],
    granizo: [
        { nome: 'INMET — Avisos meteorológicos', url: 'https://alertas2.inmet.gov.br/' },
    ],
};

/* ============================================================
   APIs de ingestão de dados — arquitetura proposta
   ("Sistema de Monitoramento - Defesa Civil MT.docx", seção 2)
   ============================================================ */
const FONTES_API = [
    { cat: 'Meteorologia', fonte: 'INMET — Estações Automáticas', api: 'apitempo.inmet.gov.br', dado: 'Temperatura, umidade, vento e pressão em tempo real', freq: 'Horária' },
    { cat: 'Meteorologia', fonte: 'INMET — Avisos Meteorológicos', api: 'alertas2.inmet.gov.br', dado: 'Polígonos de risco: calor extremo, baixa umidade, tempestade', freq: 'Contínua' },
    { cat: 'Meteorologia', fonte: 'Windy Point Forecast API', api: 'api.windy.com', dado: 'Previsão por coordenada (GFS/ECMWF), vento em altitude', freq: 'A cada 6h' },
    { cat: 'Meteorologia', fonte: 'CPTEC/INPE', api: 'tempo.cptec.inpe.br/api', dado: 'Previsão numérica e produtos climáticos regionais', freq: 'Diária' },
    { cat: 'Meteorologia', fonte: 'CPTEC/INPE (via BrasilAPI)', api: 'brasilapi.com.br/api/cptec', dado: 'Previsão 6 dias para capitais MT, sem autenticação', freq: 'Diária' },
    { cat: 'Queimadas', fonte: 'INPE — Programa Queimadas', api: 'queimadas.dgi.inpe.br', dado: 'Focos de calor por satélite, por estado/município', freq: 'Várias vezes ao dia' },
    { cat: 'Queimadas', fonte: 'NASA FIRMS', api: 'firms.modaps.eosdis.nasa.gov', dado: 'Focos de incêndio globais (fonte redundante)', freq: 'Quase tempo real' },
    { cat: 'Hidrologia', fonte: 'ANA — Hidroweb / Telemetria', api: 'telemetriaws1.ana.gov.br', dado: 'Nível de rios e reservatórios (Pantanal, Araguaia-Tocantins)', freq: 'Horária/Diária' },
    { cat: 'Qualidade do ar', fonte: 'Sensores estaduais ou estimativa', api: 'focos + vento', dado: 'Índice de qualidade do ar / risco de fumaça', freq: 'Horária' },
    { cat: 'Fogo / Incêndios', fonte: 'CENSIPAM — Painel do Fogo', api: 'panorama.sipam.gov.br/painel-do-fogo/api', dado: 'Eventos ativos/em observação, prioridade de acionamento, evolução e geometria', freq: 'Tempo real (~10 min)' },
    { cat: 'Fogo / Incêndios', fonte: 'INPE — TerraBrasilis WMS', api: 'terrabrasilis.dpi.inpe.br/queimadas/geoserver/dados_abertos/wms', dado: 'Camada raster de focos de calor (48h, todos satélites)', freq: 'Tempo real' },
    { cat: 'Fogo / Incêndios', fonte: 'INPE — BDQueimadas CSV', api: 'dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario', dado: 'Focos diários com risco de fogo, FRP, bioma, satélite, precipitação', freq: 'Diária (várias atualizações/dia)' },
];

/* Camadas da arquitetura (seção 3) */
const ARQUITETURA_CAMADAS = [
    { n: 1, nome: 'Ingestão de dados', icon: 'fa-cloud-arrow-down', desc: 'Workers agendados consultam cada API externa (INMET, INPE, ANA, Windy) em intervalos de 15 a 60 min e normalizam os dados.' },
    { n: 2, nome: 'Armazenamento', icon: 'fa-database', desc: 'PostgreSQL + PostGIS com séries temporais (temperatura, umidade, focos) e geometrias (limites municipais, polígonos de risco).' },
    { n: 3, nome: 'Motor de regras e alertas', icon: 'fa-diagram-project', desc: 'Cruza limiares operacionais e gera alertas classificados por município e nível de severidade.' },
    { n: 4, nome: 'Visualização e notificação', icon: 'fa-map-location-dot', desc: 'Mapa interativo estilo Windy para equipes técnicas; SMS, WhatsApp e push para a população em risco.' },
];

/* Limiares operacionais para MT (seção 5) */
const LIMIARES_ALERTA = [
    { cond: 'Umidade relativa do ar', limiar: 'Abaixo de 20% no período da tarde', acao: 'Alerta de saúde pública e risco de incêndio', icon: 'fa-droplet-slash', cor: '#f9631c' },
    { cond: 'Temperatura máxima', limiar: 'Acima de 40 °C', acao: 'Alerta de onda de calor', icon: 'fa-temperature-arrow-up', cor: '#ef4444' },
    { cond: 'Densidade de focos de calor', limiar: 'Acima da média histórica da região', acao: 'Alerta de fumaça e qualidade do ar', icon: 'fa-fire', cor: '#f97316' },
    { cond: 'Nível de rio (dados ANA)', limiar: 'Acima da cota de atenção', acao: 'Alerta de cheia (período chuvoso)', icon: 'fa-house-flood-water', cor: '#38bdf8' },
    { cond: 'Vento forte + baixa umidade', limiar: 'Combinação simultânea', acao: 'Alerta de propagação rápida de incêndio', icon: 'fa-wind', cor: '#facc15' },
];

/* Roadmap de implementação (seção 6) */
const ROADMAP = [
    { fase: 1, titulo: 'Protótipo (MVP)', itens: ['API do INMET (estações e avisos)', 'Focos de calor do INPE Queimadas', 'Mapa interativo básico'] },
    { fase: 2, titulo: 'Motor de alertas', itens: ['PostgreSQL + PostGIS', 'Validação de limiares com equipe técnica', 'Painel administrativo de alertas'] },
    { fase: 3, titulo: 'Notificação e hidrologia', itens: ['Integração ANA para rios', 'SMS/WhatsApp à população', 'Testes de carga e contingência 24/7'] },
    { fase: 4, titulo: 'Operação contínua', itens: ['Treinamento das equipes', 'Revisão de limiares com eventos reais', 'Novas fontes (ar, sensores locais)'] },
];

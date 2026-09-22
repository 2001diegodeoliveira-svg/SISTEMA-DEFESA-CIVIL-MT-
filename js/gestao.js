/* ============================================================
   Gestão por Município — Defesa Civil MT.
   Depende de: js/session.js, js/api.js, js/proxy.js, Leaflet.
   ============================================================ */
(function () {
    var SECOES = [
        { id: 'areasDeRisco', label: 'Áreas de Risco', desc: 'Mapeamento e cadastro das áreas sujeitas a riscos no município, com polígono desenhado no mapa.', icone: 'triangle-alert', kind: 'list', titleKey: 'nome', subKeys: ['tipo', 'risco'], fields: [
            { key: 'nome', label: 'Nome da área', req: true },
            { key: 'tipo', label: 'Tipo de risco', type: 'select', options: ['Enchente', 'Inundação', 'Alagamento', 'Deslizamento', 'Incêndio', 'Rompimento de barragem', 'Outro'] },
            { key: 'risco', label: 'Nível de risco', type: 'select', options: ['Baixo', 'Moderado', 'Alto', 'Crítico'] },
            { key: 'coords', label: 'Perímetro no mapa (clique para marcar vértices)', type: 'coords' },
            { key: 'descricao', label: 'Descrição', type: 'textarea' },
        ] },
        { id: 'plancon', label: 'Plano de Contingência', desc: 'PLANCON vigente do município. Guarde as informações principais e o link do documento.', icone: 'shield', kind: 'single', fixedId: 'plancon', titleKey: 'titulo', subKeys: ['versao', 'aprovadoEm'], fields: [
            { key: 'titulo', label: 'Título do plano', req: true },
            { key: 'versao', label: 'Versão' },
            { key: 'aprovadoEm', label: 'Data de aprovação', type: 'date' },
            { key: 'responsavel', label: 'Responsável' },
            { key: 'resumo', label: 'Resumo do plano', type: 'textarea' },
            { key: 'arquivoUrl', label: 'Link do arquivo' },
        ] },
        { id: 'coordenadores', label: 'Coordenadores', desc: 'Coordenadores municipais de Defesa Civil e equipes de apoio.', icone: 'user', kind: 'list', titleKey: 'nome', subKeys: ['cargo', 'telefone'], fields: [
            { key: 'nome', label: 'Nome', req: true },
            { key: 'cargo', label: 'Cargo' },
            { key: 'telefone', label: 'Telefone', type: 'tel' },
            { key: 'email', label: 'E-mail', type: 'email' },
            { key: 'ativo', label: 'Situação', type: 'select', options: ['Ativo', 'Inativo'] },
        ] },
        { id: 'voluntarios', label: 'Voluntários', desc: 'Rede de voluntários ativa no município para operações emergenciais.', icone: 'users', kind: 'list', titleKey: 'nome', subKeys: ['especialidade', 'disponibilidade'], fields: [
            { key: 'nome', label: 'Nome', req: true },
            { key: 'telefone', label: 'Telefone', type: 'tel' },
            { key: 'especialidade', label: 'Especialidade' },
            { key: 'disponibilidade', label: 'Disponibilidade', type: 'select', options: ['Imediata', 'Após contato', 'Indisponível'] },
            { key: 'ativo', label: 'Situação', type: 'select', options: ['Ativo', 'Inativo'] },
        ] },
        { id: 'inventario', label: 'Inventário de Emergência', desc: 'Materiais e insumos de pronta resposta estocados no município.', icone: 'package', kind: 'list', titleKey: 'item', subKeys: ['quantidade', 'local'], fields: [
            { key: 'item', label: 'Item', req: true },
            { key: 'categoria', label: 'Categoria', type: 'select', options: ['Alimentação', 'Água', 'Medicamentos', 'Combustível', 'Ferramentas', 'Material de abrigo', 'EPI', 'Comunicação', 'Iluminação', 'Outro'] },
            { key: 'quantidade', label: 'Quantidade', type: 'number' },
            { key: 'unidade', label: 'Unidade' },
            { key: 'local', label: 'Local de armazenamento' },
            { key: 'condicao', label: 'Condição', type: 'select', options: ['Bom', 'Regular', 'Ruim', 'Inspecionar'] },
        ] },
        { id: 'rotasFuga', label: 'Rotas de Fuga', desc: 'Rotas de evacuação indicadas à população, com traçado no mapa.', icone: 'route', kind: 'list', titleKey: 'nome', subKeys: ['origem', 'destino', 'status'], fields: [
            { key: 'nome', label: 'Nome da rota', req: true },
            { key: 'origem', label: 'Origem' },
            { key: 'destino', label: 'Destino' },
            { key: 'tipo', label: 'Tipo', type: 'select', options: ['A pé', 'Veículo', 'Misto'] },
            { key: 'status', label: 'Status', type: 'select', options: ['Ativa', 'Em manutenção', 'Desativada'] },
            { key: 'coords', label: 'Traçado no mapa (clique para marcar pontos)', type: 'coords' },
            { key: 'descricao', label: 'Descrição', type: 'textarea' },
        ] },
        { id: 'viaturas', label: 'Viaturas', desc: 'Veículos de resposta do município, situação e responsável.', icone: 'truck', kind: 'list', titleKey: 'nome', subKeys: ['placa', 'situacao'], fields: [
            { key: 'nome', label: 'Identificação', req: true },
            { key: 'placa', label: 'Placa' },
            { key: 'tipo', label: 'Tipo', type: 'select', options: ['Ambulância', 'Caminhonete', 'Viatura de resgate', 'Caminhão', 'Van', 'Moto', 'Outro'] },
            { key: 'capacidade', label: 'Capacidade' },
            { key: 'situacao', label: 'Situação', type: 'select', options: ['Operante', 'Manutenção', 'Indisponível'] },
            { key: 'responsavel', label: 'Responsável' },
            { key: 'observacao', label: 'Observação', type: 'textarea' },
        ] },
        { id: 'rastreadorRadio', label: 'Rastreador / Rádio', desc: 'Configuração da integração com a API de rastreador e canais de rádio.', icone: 'radio', kind: 'single', fixedId: 'rastreadorRadio', titleKey: 'apiUrl', subKeys: ['prefixo', 'canais'], fields: [
            { key: 'apiUrl', label: 'URL da API do rastreador' },
            { key: 'prefixo', label: 'Prefixo / Código do rastreador' },
            { key: 'canais', label: 'Canais de rádio' },
            { key: 'frequencia', label: 'Frequência' },
            { key: 'observacao', label: 'Observação', type: 'textarea' },
        ] },
        { id: 'equipeAtual', label: 'Equipe Atual', desc: 'Equipe de prontidão atual do município, função e plantão.', icone: 'hard-hat', kind: 'list', titleKey: 'nome', subKeys: ['funcao', 'status'], fields: [
            { key: 'nome', label: 'Nome', req: true },
            { key: 'funcao', label: 'Função' },
            { key: 'telefone', label: 'Telefone', type: 'tel' },
            { key: 'plantao', label: 'Plantão', type: 'select', options: ['24h', '12h', 'Sob demanda'] },
            { key: 'status', label: 'Status', type: 'select', options: ['Ativo', 'Em plantão', 'Treinamento', 'Afastado'] },
        ] },
        { id: 'sede', label: 'Sede da Defesa Civil', desc: 'Sede municipal da Defesa Civil, endereço e localização.', icone: 'building-2', kind: 'single', fixedId: 'sede', titleKey: 'nome', subKeys: ['logradouro'], fields: [
            { key: 'nome', label: 'Nome da sede' },
            { key: 'logradouro', label: 'Endereço' },
            { key: 'contato', label: 'Contato', type: 'tel' },
            { key: 'latlng', label: 'Localização no mapa (clique para posicionar)', type: 'latlng' },
            { key: 'observacoes', label: 'Observações', type: 'textarea' },
        ] },
        { id: 'alojamento', label: 'Alojamento / Abrigo', desc: 'Abrigos e alojamentos para acolhimento de desabrigados.', icone: 'bed-double', kind: 'list', titleKey: 'nome', subKeys: ['capacidade', 'vagas', 'condicao'], fields: [
            { key: 'nome', label: 'Nome do abrigo', req: true },
            { key: 'endereco', label: 'Endereço' },
            { key: 'capacidade', label: 'Capacidade (lotação)', type: 'number' },
            { key: 'vagas', label: 'Vagas livres', type: 'number' },
            { key: 'condicao', label: 'Condição', type: 'select', options: ['Operacional', 'Em obras', 'Indisponível'] },
            { key: 'contato', label: 'Contato', type: 'tel' },
            { key: 'latlng', label: 'Localização no mapa (clique para posicionar)', type: 'latlng' },
        ] },
    ];

    var FALLBACK_MUNS = ['Cuiabá', 'Várzea Grande', 'Rondonópolis', 'Sinop', 'Tangará da Serra', 'Cáceres', 'Sorriso', 'Lucas do Rio Verde', 'Primavera do Leste', 'Barra do Garças'];

    var SESSION = null;
    var CAN_EDIT = false;
    var IS_MUNICIPAL = false;
    var IS_ESTADUAL = false;
    var MUN = '';
    var DOC = { secoes: {} };
    var curSec = 'visao';
    var editingId = null;
    var buf = { coords: {}, latlng: {}, dirty: {} };
    var toastTimer = null;

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function metaSec(id) {
        for (var i = 0; i < SECOES.length; i++) if (SECOES[i].id === id) return SECOES[i];
        return null;
    }
    function norm(s) {
        return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    }
    function fmtData(ms) {
        if (!ms) return '—';
        var d = new Date(ms);
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
    }

    /* ============ inicialização ============ */
    function init() {
        SESSION = dcGetSession();
        if (!SESSION) { location.href = 'login.html'; return; }
        if (SESSION.perfil === 'comum') { location.href = 'alertas.html'; return; }
        CAN_EDIT = SESSION.perfil === 'municipal';
        IS_MUNICIPAL = SESSION.perfil === 'municipal';
        IS_ESTADUAL = SESSION.perfil === 'admin';
        dcRenderUserArea();

        if (IS_MUNICIPAL) {
            MUN = String(SESSION.municipio || '').trim();
            $('munSelWrap').style.display = 'none';
            var fx = $('munFixed');
            if (MUN) {
                fx.innerHTML = '<div class="mun-fixed"><i data-lucide="pin"></i><div><b>' + esc(MUN) + '</b><span>Seu município (gestor local)</span></div></div>';
            } else {
                $('munLockNotice').innerHTML = '<div class="banner warn">Seu perfil ainda não está vinculado a um município. Fale com um administrador do estado.</div>';
                fx.innerHTML = '<div class="mun-fixed"><i data-lucide="lock"></i><div><b>Sem município</b><span>acesso restrito</span></div></div>';
            }
            if (window.lucide) lucide.createIcons();
            if (MUN) loadDoc();
            else loadingErro('Perfil gestor sem município vinculado.');
            return;
        }

        if (IS_ESTADUAL) {
            $('munSelWrap').style.display = 'none';
            $('tabsTitle').style.display = 'none';
            $('tabsNav').style.display = 'none';
            $('munFixed').innerHTML = '<div class="mun-fixed"><i data-lucide="bar-chart-3"></i><div><b>Visão Estadual</b><span>gestor estadual · somente leitura</span></div></div>';
            if (window.lucide) lucide.createIcons();
            carregarVisaoEstadual();
            return;
        }

        loadMunis();
    }

    function loadingErro(msg) {
        $('panelArea').innerHTML = '<div class="empty" style="padding:20px 6px;"><i data-lucide="alert-circle"></i>' + esc(msg) + '</div>';
        if (window.lucide) lucide.createIcons();
    }

    function loadMunis() {
        var sel = $('munSel');
        var saved = sessionStorage.getItem('dcm_gestao_mun') || '';
        dcProxyFetch('https://servicodados.ibge.gov.br/api/v1/localidades/estados/51/municipios?orderBy=nome')
            .then(function (r) { if (!r.ok) throw new Error('ibge'); return r.json(); })
            .then(function (list) {
                if (!Array.isArray(list) || !list.length) throw new Error('vazio');
                sel.innerHTML = list.map(function (m) { return '<option value="' + esc(m.nome) + '">' + esc(m.nome) + '</option>'; }).join('');
                sel.value = saved && list.some(function (m) { return m.nome === saved; }) ? saved : 'Cuiabá';
                onMun();
            })
            .catch(function () {
                sel.innerHTML = FALLBACK_MUNS.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
                sel.value = saved || 'Cuiabá';
                onMun();
            });
    }

    function onMun() {
        MUN = $('munSel').value;
        sessionStorage.setItem('dcm_gestao_mun', MUN);
        loadDoc();
    }

    function loadDoc() {
        if (!MUN) return;
        $('panelArea').innerHTML = '<div class="loading"><i data-lucide="loader"></i> Carregando dados de ' + esc(MUN) + '…</div>';
        if (window.lucide) lucide.createIcons();
        dcApi.gestao(MUN).then(function (r) {
            DOC = (r.ok && r.data && r.data.secoes) ? r.data : { secoes: {} };
            renderTabs();
            switchTab(curSec);
        }).catch(function () {
            loadingErro('Falha ao carregar os dados. Verifique a conexão com o servidor.');
        });
    }

    /* ============ visão geral de um município ============ */
    function renderVisaoGeral() {
        curSec = 'visao';
        renderTabs();
        var preenchidas = 0, itens = 0, geos = 0;
        var cards = SECOES.map(function (s) {
            var n = Array.isArray(DOC.secoes[s.id]) ? DOC.secoes[s.id].length : 0;
            itens += n;
            if (n > 0) preenchidas++;
            var temGeo = false;
            if (n > 0) {
                try {
                    temGeo = DOC.secoes[s.id].some(function (x) {
                        return (Array.isArray(x.coords) && x.coords.length) || (Array.isArray(x.latlng) && x.latlng.length === 2);
                    });
                } catch (e) {}
            }
            if (temGeo) geos++;
            var ok = n > 0
                ? (s.kind === 'single' ? 'Cadastrado' : n + (n === 1 ? ' registro' : ' registros'))
                : (s.kind === 'single' ? 'Não cadastrado' : 'Sem registros');
            var cor = n > 0 ? 'var(--green)' : 'var(--accent-orange)';
            return '<div class="ov-card" data-sec="' + s.id + '" onclick="GESTAO.renderSecao(\'' + s.id + '\')">' +
                '<i data-lucide="' + s.icone + '" style="color:' + cor + '"></i>' +
                '<div class="ov-info"><b>' + esc(s.label) + '</b><span>' + ok + (temGeo ? ' · com mapa' : '') + '</span></div>' +
                '<em>' + (n ? n : '—') + '</em>' +
                '</div>';
        }).join('');
        var pct = Math.round((preenchidas / SECOES.length) * 100);
        var fato = preenchidas === SECOES.length;

        var html = '<div class="ve-top"><div>' +
            '<div class="ve-kicker">' + (IS_MUNICIPAL ? 'Sua gestão' : 'Município em visualização') + '</div>' +
            '<h2>Visão Geral — ' + esc(MUN) + '</h2>' +
            '<p>Situação do cadastro operacional: <b>' + preenchidas + ' de ' + SECOES.length + '</b> seções com informações registradas' +
            (IS_MUNICIPAL ? '. Toque em cada card para abrir e preencher a seção.' : '. Acesso somente leitura para o gestor estadual.') + '</p>' +
            '</div>' +
            (IS_MUNICIPAL
                ? '<button class="btn-refresh" onclick="GESTAO.atualizar()"><i data-lucide="rotate-cw"></i> Atualizar</button>'
                : '') + '</div>';

        html += '<div class="ve-cards">' +
            '<div class="ve-card"><i data-lucide="clipboard-check" style="color:var(--green)"></i><b>' + preenchidas + '/' + SECOES.length + '</b><span>seções preenchidas</span></div>' +
            '<div class="ve-card"><i data-lucide="database" style="color:var(--blue-glow)"></i><b>' + itens + '</b><span>registros cadastrados</span></div>' +
            '<div class="ve-card"><i data-lucide="map-pinned" style="color:var(--blue-glow)"></i><b>' + geos + '</b><span>seções com mapa/ponto</span></div>' +
            '<div class="ve-card"><i data-lucide="' + (fato ? 'badge-check' : 'triangle-alert') + '" style="color:' + (fato ? 'var(--green)' : 'var(--accent-orange)') + '"></i><b>' + (fato ? 'Completo' : SECOES.length - preenchidas) + '</b><span>' + (fato ? '11/11 — pronto' : 'seção(ões) pendente(s)') + '</span></div>' +
            '</div>';

        html += '<div class="card" style="margin-bottom:18px;"><div class="card-ttl">Progresso de cadastro</div>' +
            '<div class="ov-prog"><div class="ov-prog-fill" style="width:' + pct + '%;' + (fato ? 'background:var(--green)' : '') + '"></div></div>' +
            '<span style="font-size:11px;color:var(--text-muted);">' + pct + '% das seções com informação — clique nos cards abaixo para ver cada seção.</span></div>';

        html += '<div class="ov-grid">' + cards + '</div>';

        $('panelArea').innerHTML = html;
        if (window.lucide) lucide.createIcons();
    }

    /* ============ abas ============ */
    function renderTabs() {
        var nav = $('tabsNav');
        var visaoBtn = '<button class="tab' + (curSec === 'visao' ? ' active' : '') + '" data-sec="visao">' +
            '<i data-lucide="layout-dashboard"></i><span>Visão Geral</span></button>';
        nav.innerHTML = visaoBtn + SECOES.map(function (s) {
            var n = Array.isArray(DOC.secoes[s.id]) ? DOC.secoes[s.id].length : 0;
            var badge = s.kind === 'single' ? (n ? '<em>OK</em>' : '') : (n ? '<em>' + n + '</em>' : '');
            return '<button class="tab' + (s.id === curSec ? ' active' : '') + '" data-sec="' + s.id + '">' +
                '<i data-lucide="' + s.icone + '"></i><span>' + s.label + '</span>' + badge + '</button>';
        }).join('');
        Array.prototype.forEach.call(nav.querySelectorAll('.tab'), function (b) {
            b.addEventListener('click', function () { var id = b.getAttribute('data-sec'); switchTabConciliado(id); });
        });
        if (window.lucide) lucide.createIcons();
    }

    function switchTab(id) {
        curSec = id;
        renderTabs();
        if (id === 'visao') { renderVisaoGeral(); return; }
        renderPanel(id, null);
    }

    function switchTabConciliado(id) {
        switchTab(id);
    }

    /* ============ painel ============ */
    function renderPanel(id, editId) {
        var meta = metaSec(id);
        if (!meta) return;
        editingId = editId;
        var items = Array.isArray(DOC.secoes[id]) ? DOC.secoes[id] : [];
        var single = meta.kind === 'single';
        var item = single ? (items.length ? items[0] : null) : (editId ? (items.find(function (x) { return String(x.id) === String(editId); }) || null) : null);

        buf.coords[id] = (item && Array.isArray(item.coords)) ? item.coords.map(function (p) { return [p[0], p[1]]; }) : [];
        buf.latlng[id] = (item && Array.isArray(item.latlng) && item.latlng.length === 2) ? [item.latlng[0], item.latlng[1]] : null;
        buf.dirty[id] = false;

        var html = '';
        html += '<div class="p-head"><div><h2>' + meta.label + '</h2><p>' + meta.desc + '</p></div>' +
            (IS_MUNICIPAL ? '' : '<span class="chip" style="align-self:flex-start;">Município: ' + esc(MUN) + '</span>') + '</div>';
        html += '<div class="p-grid' + (single || !items.length ? ' p-grid-single' : '') + '">';
        html += '<div class="card form-card"><div class="card-ttl">' + (item && !single ? 'Editando registro' : (single ? 'Registro ativo' : 'Novo registro')) + '</div>';
        html += '<form id="frm" onsubmit="return GESTAO.save(event)">';
        meta.fields.forEach(function (f) { html += fieldHTML(id, f, item); });
        html += '<div class="form-actions">';
        if (CAN_EDIT) {
            html += '<button type="submit" class="btn-save"><i data-lucide="save"></i> Salvar</button>';
            if (single && item) html += '<button type="button" class="btn-del" onclick="GESTAO.del(\'' + id + '\')"><i data-lucide="trash-2"></i> Remover registro</button>';
            if (!single && editId) html += '<button type="button" class="btn-mini ghost" onclick="GESTAO.render(\'' + id + '\',null)">Cancelar edição</button>';
        } else {
            html += '<span style="font-size:12px;color:var(--text-muted);">Perfil de leitura — edições bloqueadas.</span>';
        }
        html += '</div>';
        html += '</form></div>';
        if (!single) html += listHTML(id, meta, items);
        html += '</div>';
        $('panelArea').innerHTML = html;
        if (window.lucide) lucide.createIcons();
        renderPtsTexts(id, meta);
    }

    function fieldHTML(id, f, item) {
        var val = (item && item[f.key] != null) ? item[f.key] : '';
        var elem;
        if (f.type === 'textarea') {
            elem = '<textarea id="fk_' + id + '_' + f.key + '" rows="2" placeholder="' + f.label + '">' + esc(val) + '</textarea>';
        } else if (f.type === 'select') {
            elem = '<select id="fk_' + id + '_' + f.key + '">' + f.options.map(function (o) {
                return '<option' + (String(val) === o ? ' selected' : '') + '>' + esc(o) + '</option>';
            }).join('') + '</select>';
        } else if (f.type === 'number') {
            elem = '<input id="fk_' + id + '_' + f.key + '" type="number" value="' + esc(val) + '">';
        } else if (f.type === 'date') {
            elem = '<input id="fk_' + id + '_' + f.key + '" type="date" value="' + esc(val) + '">';
        } else if (f.key === 'coords' || f.key === 'latlng') {
            var pts = '';
            if (f.key === 'coords' && Array.isArray(val)) pts = val.map(function (p) { return (p[0]).toFixed(5) + ',' + (p[1]).toFixed(5); }).join(' · ');
            if (f.key === 'latlng' && Array.isArray(val)) pts = (val[0]).toFixed(5) + ', ' + (val[1]).toFixed(5);
            elem = '<div class="coord-field">' +
                '<input type="text" readonly value="' + esc(pts) + '" placeholder="Nenhum ponto marcado" id="fk_' + id + '_' + f.key + '_txt">' +
                '<button type="button" class="btn-mini" onclick="GESTAO.openMap(\'' + id + '\',\'' + f.key + '\')"><i data-lucide="map-pin"></i> Abrir mapa</button>' +
                '<button type="button" class="btn-mini ghost" onclick="GESTAO.clearMap(\'' + id + '\',\'' + f.key + '\')"><i data-lucide="eraser"></i> Limpar</button>' +
                '</div><div id="mmWrap_' + id + '_' + f.key + '" class="mm-wrap" style="display:none;"></div>';
        } else {
            var t = f.type || 'text';
            elem = '<input id="fk_' + id + '_' + f.key + '" type="' + t + '" value="' + esc(val) + '">';
        }
        return '<label class="fld"><span>' + (f.req ? '* ' : '') + esc(f.label) + '</span>' + elem + '</label>';
    }

    function listHTML(id, meta, items) {
        if (!items.length) return '<div class="card empty"><i data-lucide="inbox"></i> Nenhum registro cadastrado ainda.</div>';
        var rows = items.map(function (it) {
            var title = it[meta.titleKey] || it[meta.fields[0].key] || 'Registro';
            var sub = meta.subKeys.filter(function (k) { return it[k] != null && it[k] !== ''; }).map(function (k) { return it[k]; }).join(' · ');
            var coordChip = '';
            if (Array.isArray(it.coords) && it.coords.length) coordChip = '<span class="chip">' + it.coords.length + ' ponto(s)</span>';
            else if (Array.isArray(it.latlng)) coordChip = '<span class="chip">geo</span>';
            return '<div class="row">' + coordChip +
                '<div class="r-main"><b>' + esc(title) + '</b><span>' + esc(sub) + '</span></div>' +
                '<div class="r-act">' +
                (CAN_EDIT
                    ? '<button class="btn-mini" title="Editar" onclick="GESTAO.render(\'' + id + '\',\'' + it.id + '\')"><i data-lucide="pencil"></i></button>' +
                      '<button class="btn-mini ghost" title="Excluir" onclick="GESTAO.del(\'' + id + '\',\'' + it.id + '\')"><i data-lucide="trash-2"></i></button>'
                    : '') +
                '</div></div>';
        }).join('');
        return '<div class="card list-card"><div class="card-ttl">' + items.length + ' registro(s)</div>' + rows + '</div>';
    }

    function renderPtsTexts(id, meta) {
        meta.fields.forEach(function (f) {
            if (f.key !== 'coords' && f.key !== 'latlng') return;
            var t = $('fk_' + id + '_' + f.key + '_txt');
            if (!t) return;
            if (f.key === 'latlng') {
                t.value = buf.latlng[id] ? (buf.latlng[id][0]).toFixed(5) + ', ' + (buf.latlng[id][1]).toFixed(5) : '';
            } else {
                t.value = buf.coords[id].map(function (p) { return p[0].toFixed(5) + ',' + p[1].toFixed(5); }).join(' · ');
            }
        });
    }

    /* ============ mini mapa ============ */
    function openMap(id, key) {
        var wrap = $('mmWrap_' + id + '_' + key);
        if (!wrap) return;
        wrap.style.display = 'block';
        var m = wrap._map;
        if (!m) {
            m = L.map(wrap, { zoomControl: true }).setView([-13.5, -56], 6);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
            wrap._map = m;
            wrap._layer = L.layerGroup().addTo(m);
            m.on('click', function (ev) {
                var ll = [ev.latlng.lat, ev.latlng.lng];
                if (key === 'latlng') {
                    buf.latlng[id] = ll;
                    buf.dirty[id] = true;
                    wrap._layer.clearLayers();
                    L.marker(ll).addTo(wrap._layer);
                } else {
                    buf.coords[id].push(ll);
                    buf.dirty[id] = true;
                    drawShape(id, key, wrap);
                }
                renderPtsTexts(id, metaSec(id));
            });
        }
        wrap._layer.clearLayers();
        if (key === 'latlng') {
            if (buf.latlng[id]) L.marker(buf.latlng[id]).addTo(wrap._layer);
        } else {
            drawShape(id, key, wrap);
        }
        m.invalidateSize();
    }

    function drawShape(id, key, wrap) {
        var pts = buf.coords[id] || [];
        wrap._layer.clearLayers();
        var latlngs = pts.map(function (p) { return L.latLng(p[0], p[1]); });
        latlngs.forEach(function (ll, i) {
            var mk = L.circleMarker(ll, { radius: 5, color: '#00d2ff', fillColor: '#00d2ff', fillOpacity: .7 });
            mk.bindTooltip('Ponto ' + (i + 1), { permanent: false, direction: 'top', className: 'mm-tip' });
            mk.addTo(wrap._layer);
        });
        if (latlngs.length >= 3 && key === 'coords' && metaSec(id).fields.some(function (f) { return f.key === 'coords' && metaSec(id).id === 'areasDeRisco'; })) {
            L.polygon(latlngs, { color: '#f9731c', weight: 2, fillColor: '#f9731c', fillOpacity: .18 }).addTo(wrap._layer);
        } else if (latlngs.length >= 2) {
            L.polyline(latlngs, { color: '#f9731c', weight: 3, opacity: .9 }).addTo(wrap._layer);
        }
    }

    function clearMap(id, key) {
        if (key === 'latlng') { buf.latlng[id] = null; } else { buf.coords[id] = []; }
        buf.dirty[id] = true;
        var wrap = $('mmWrap_' + id + '_' + key);
        if (wrap && wrap._layer) { wrap._layer.clearLayers(); }
        renderPtsTexts(id, metaSec(id));
    }

    /* ============ CRUD ============ */
    function save(ev) {
        ev.preventDefault();
        if (!CAN_EDIT) { toast('Seu perfil tem acesso somente de leitura.'); return; }
        if (!MUN) { toast('Selecione um município.'); return; }
        var meta = metaSec(curSec);
        var item = {};
        var firstErr = null;
        meta.fields.forEach(function (f) {
            if (f.key === 'coords') { item.coords = buf.coords[curSec]; return; }
            if (f.key === 'latlng') { if (buf.latlng[curSec]) item.latlng = buf.latlng[curSec]; return; }
            var el = $('fk_' + curSec + '_' + f.key);
            item[f.key] = el ? el.value : '';
        });
        meta.fields.forEach(function (f) {
            if (!f.req) return;
            if (f.key === 'coords' || f.key === 'latlng') return;
            var v = item[f.key];
            var okv = v != null && String(v).trim() !== '';
            if (!okv && !firstErr) firstErr = f;
        });
        if (firstErr) {
            toast('Preencha o campo "' + firstErr.label + '".');
            return;
        }
        if (editingId) item.id = editingId;
        if (meta.kind === 'single' && meta.fixedId) item.id = meta.fixedId;

        dcApi.gestaoSalvar(MUN, curSec, item).then(function (r) {
            if (r.ok && r.data && r.data.ok) {
                toast('Registro salvo com sucesso.', true);
                DOC.secoes[curSec] = r.data.items || [];
                editingId = null;
                switchTab(curSec);
            } else {
                toast((r.data && r.data.erro) || 'Não foi possível salvar.');
            }
        }).catch(function () { toast('Falha de conexão ao salvar.'); });
        return false;
    }

    function del(id, itemId) {
        if (!CAN_EDIT) { toast('Seu perfil tem acesso somente de leitura.'); return; }
        var label = itemId ? 'Excluir este registro?' : 'Excluir o registro desta seção?';
        if (!confirm(label)) return;
        dcApi.gestaoRemover(MUN, id, itemId || metaSec(id).fixedId || '').then(function (r) {
            if (r.ok && r.data && r.data.ok) {
                toast('Registro excluído.', true);
                DOC.secoes[id] = r.data.items || [];
                editingId = null;
                switchTab(id);
            } else {
                toast((r.data && r.data.erro) || 'Não foi possível excluir.');
            }
        }).catch(function () { toast('Falha de conexão ao excluir.'); });
    }

    function render(id, editId) {
        renderPanel(id, editId);
    }

    /* ============ visão estadual (dashboard) ============ */
    function carregarVisaoEstadual() {
        var vb = $('veBar');
        if (vb) vb.style.display = 'none';
        var tt = $('tabsTitle');
        var tn = $('tabsNav');
        if (tt) tt.style.display = 'none';
        if (tn) tn.style.display = 'none';
        $('panelArea').innerHTML = '<div class="loading"><i data-lucide="loader"></i> Consolidando a gestão dos 142 municípios…</div>';
        if (window.lucide) lucide.createIcons();
        dcApi.gestaoVisaoGeral().then(function (r) {
            if (!r.ok || !r.data || !r.data.ok || !r.data.municipios) throw new Error('falha');
            renderVisaoEstadual(r.data);
        }).catch(function () {
            loadingErro('Falha ao carregar o panorama estadual. Verifique a conexão com o servidor.');
        });
    }

    function renderVisaoEstadual(dado) {
        curSec = 'areasDeRisco';
        var tot = dado.totais || { comCadastro: 0, pendentes: 0, itens: 0, completos: 0 };

        var secTotais = SECOES.map(function (s) {
            var n = 0;
            (dado.municipios || []).forEach(function (m) { n += (m.secoes && m.secoes[s.id]) || 0; });
            return { label: s.label, n: n };
        });
        var maxSec = Math.max(1, secTotais.reduce(function (a, b) { return Math.max(a, b.n); }, 0));
        var bars = secTotais.map(function (s) {
            var w = Math.round((s.n / maxSec) * 100);
            return '<div class="ve-bar-row"><span class="ve-bar-label">' + esc(s.label) + '</span>' +
                '<div class="ve-bar-track"><div class="ve-bar-fill" style="width:' + w + '%"></div></div>' +
                '<span class="ve-bar-n">' + s.n + '</span></div>';
        }).join('');

        var ord = (dado.municipios || []).slice().sort(function (a, b) {
            if (b.preenchidas !== a.preenchidas) return b.preenchidas - a.preenchidas;
            return b.totalItems - a.totalItems;
        });
        var rows = ord.map(function (m, i) {
            var pct = Math.round((m.preenchidas / 11) * 100);
            var cor = m.completa ? '#16a34a' : (pct >= 50 ? '#fbbf24' : 'var(--accent-orange)');
            return '<tr data-search="' + esc(String(m.nome + ' ' + m.mun).toLowerCase()) + '">' +
                '<td class="ve-td-num">' + (i + 1) + '</td>' +
                '<td><b>' + esc(m.nome) + '</b><span class="ve-td-mun">@' + esc(m.mun) + '</span></td>' +
                '<td><div class="ve-prog"><div class="ve-prog-fill" style="width:' + pct + '%;background:' + cor + '"></div></div><span class="ve-prog-txt">' + m.preenchidas + '/11</span></td>' +
                '<td class="ve-td-num">' + m.totalItems + '</td>' +
                '<td class="ve-td-date">' + fmtData(m.atualizadoEm) + '</td>' +
                '<td><button class="btn-mini" data-mun="' + encodeURIComponent(m.nome) + '" onclick="GESTAO.verMunicipio(decodeURIComponent(this.getAttribute(\'data-mun\')))"><i data-lucide="eye"></i> Ver</button></td>' +
                '</tr>';
        }).join('');

        var html = '<div class="ve-top"><div>' +
            '<div class="ve-kicker">Painel do gestor estadual</div>' +
            '<h2>Visão Estadual — Gestão por Município</h2>' +
            '<p>Panorama do cadastro operacional dos ' + dado.totalMunicipios + ' municípios de Mato Grosso. Acesso somente leitura.</p>' +
            '</div>' +
            '<button class="btn-refresh" onclick="GESTAO.atualizarVisao()"><i data-lucide="rotate-cw"></i> Atualizar</button>' +
            '</div>';

        html += '<div class="ve-cards">' +
            '<div class="ve-card"><i data-lucide="building-2" style="color:var(--green)"></i><b>' + tot.comCadastro + '</b><span>municípios com cadastro</span></div>' +
            '<div class="ve-card"><i data-lucide="database" style="color:var(--blue-glow)"></i><b>' + tot.itens + '</b><span>registros no total</span></div>' +
            '<div class="ve-card"><i data-lucide="badge-check" style="color:var(--green)"></i><b>' + tot.completos + '</b><span>municípios 11/11</span></div>' +
            '<div class="ve-card"><i data-lucide="alert-triangle" style="color:var(--accent-orange)"></i><b>' + tot.pendentes + '</b><span>sem cadastro ainda</span></div>' +
            '</div>';

        html += '<div class="ve-grid">' +
            '<div class="card"><div class="card-ttl">Registros por seção (todos os municípios)</div>' + bars + '</div>' +
            '<div class="card"><div class="card-ttl">Mapa de preenchimento</div>' +
            '<div class="ve-legend">' +
            '<span class="ve-lg ve-lg-0">Vazio</span>' +
            '<span class="ve-lg ve-lg-1">1–3</span>' +
            '<span class="ve-lg ve-lg-2">4–7</span>' +
            '<span class="ve-lg ve-lg-3">8–10</span>' +
            '<span class="ve-lg ve-lg-4">11/11</span>' +
            '</div>' +
            '<div id="veMap" class="ve-map"></div>' +
            '</div>' +
            '</div>';

        html += '<div class="card">' +
            '<div class="card-ttl">Preenchimento por município</div>' +
            '<input type="text" id="veFiltro" class="ve-busca" placeholder="Filtrar município… (ex.: sinop, cáceres, várzea)" oninput="GESTAO.filtrarVisao()">' +
            '<div class="ve-table-wrap"><table class="ve-table"><thead><tr>' +
            '<th>#</th><th>Município</th><th>Preenchimento</th><th>Itens</th><th>Atualização</th><th></th>' +
            '</tr></thead><tbody id="veTbody">' + rows + '</tbody></table></div>' +
            '</div>';

        $('panelArea').innerHTML = html;
        if (window.lucide) lucide.createIcons();
        montarMapaVisao(dado);
    }

    function corMapa(pre) {
        if (pre >= 11) return '#16a34a';
        if (pre >= 8) return '#65a30d';
        if (pre >= 4) return '#fbbf24';
        if (pre >= 1) return '#fb923c';
        return '#1e293b';
    }

    function montarMapaVisao(dado) {
        var el = $('veMap');
        if (!el) return;
        if (window.veMapInst) { window.veMapInst.remove(); window.veMapInst = null; }
        var m = L.map(el, { zoomControl: true, scrollWheelZoom: false }).setView([-12.8, -55.5], 5);
        window.veMapInst = m;
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19, attribution: '© OpenStreetMap · © CARTO',
        }).addTo(m);
        var porNorm = {};
        (dado.municipios || []).forEach(function (x) { porNorm[norm(x.nome)] = x; });
        dcProxyFetch('https://servicodados.ibge.gov.br/api/v3/malhas/estados/51?formato=application/vnd.geo+json&intrarregiao=municipio&qualidade=minima')
            .then(function (r) { if (!r.ok) throw new Error('ibge'); return r.json(); })
            .then(function (geo) {
                var features = (geo && geo.features) ? geo.features : [];
                features.forEach(function (f) {
                    var nome = f.properties && (f.properties.nome || f.properties.name || '');
                    var info = porNorm[norm(nome)] || null;
                    var pre = info ? info.preenchidas : 0;
                    L.geoJSON(f, {
                        style: { color: 'rgba(255,255,255,.25)', weight: .7, fillColor: corMapa(pre), fillOpacity: .85 },
                    }).bindTooltip('<b>' + esc(nome) + '</b><br>' + pre + '/11 seções · ' + (info ? info.totalItems : 0) + ' itens', { sticky: true })
                        .on('click', function () { if (info) GESTAO.verMunicipio(info.nome); })
                        .addTo(m);
                });
                try { m.fitBounds(L.geoJSON(geo).getBounds()); } catch (e) {}
            })
            .catch(function () {
                el.innerHTML = '<div class="empty" style="padding:14px 6px;"><i data-lucide="map-off"></i> Mapa indisponível (malhas IBGE).</div>';
                if (window.lucide) lucide.createIcons();
            });
    }

    function verMunicipio(nome) {
        MUN = nome;
        curSec = 'visao';
        var vb = $('veBar');
        if (vb) vb.style.display = '';
        $('munSelWrap').style.display = 'none';
        $('munFixed').innerHTML = '<div class="mun-fixed"><i data-lucide="pin"></i><div><b>' + esc(nome) + '</b><span>visualização estadual · somente leitura</span></div></div>';
        var tt = $('tabsTitle');
        var tn = $('tabsNav');
        if (tt) tt.style.display = '';
        if (tn) tn.style.display = '';
        if (window.lucide) lucide.createIcons();
        loadDoc();
    }

    function voltarVisao() {
        var vb = $('veBar');
        if (vb) vb.style.display = 'none';
        carregarVisaoEstadual();
    }

    function filtrarVisao() {
        var q = norm($('veFiltro').value);
        var rows = document.querySelectorAll('#veTbody tr');
        for (var i = 0; i < rows.length; i++) {
            rows[i].style.display = (rows[i].getAttribute('data-search') || '').indexOf(q) >= 0 ? '' : 'none';
        }
    }

    /* ============ toast ============ */
    function toast(msg, ok) {
        var t = $('toast');
        t.textContent = msg;
        t.className = 'toast show' + (ok ? ' ok' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
    }

    window.GESTAO = {
        init: init,
        onMun: onMun,
        save: save,
        del: del,
        render: render,
        openMap: openMap,
        clearMap: clearMap,
        renderSecao: switchTab,
        atualizar: function () { loadDoc(); },
        atualizarVisao: carregarVisaoEstadual,
        voltarVisao: voltarVisao,
        verMunicipio: verMunicipio,
        filtrarVisao: filtrarVisao,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
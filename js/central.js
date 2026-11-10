/* ============================================================
   Central de Ocorrências — camada de interface.
   Consome /api/central/* (autenticado). Não cria dados fictícios.
   ============================================================ */
(function () {
    'use strict';

    var PRIORIDADES = ['BAIXA', 'MODERADA', 'ALTA', 'CRITICA'];
    var PRIORIDADE_LABEL = { BAIXA: 'Baixa', MODERADA: 'Moderada', ALTA: 'Alta', CRITICA: 'Crítica' };
    var STATUS_LABEL = {
        REGISTRADA: 'Registrada',
        EM_TRIAGEM: 'Em triagem',
        EM_AVALIACAO: 'Em avaliação',
        AGUARDANDO_MOBILIZACAO: 'Aguardando mobilização',
        EQUIPE_MOBILIZADA: 'Equipe mobilizada',
        EM_ATENDIMENTO: 'Em atendimento',
        MONITORAMENTO: 'Monitoramento',
        CONCLUIDA: 'Concluída',
        ARQUIVADA: 'Arquivada',
        ESCALADA: 'Escalada (legado)'
    };
    var VERIFICACAO_LABEL = {
        ALERTA: 'Alerta / previsão', SUSPEITA: 'Suspeita', RELATADA: 'Relatada', CONFIRMADA: 'Confirmada'
    };
    var MOBILIZACAO_LABEL = {
        mobilizada: 'Mobilizada', em_deslocamento: 'Em deslocamento', no_local: 'No local',
        retornando: 'Retornando', encerrada: 'Encerrada'
    };

    var UF_NOMES = {
        '11':'Rondônia','12':'Acre','13':'Amazonas','14':'Roraima','15':'Pará','16':'Amapá','17':'Tocantins',
        '21':'Maranhão','22':'Piauí','23':'Ceará','24':'Rio Grande do Norte','25':'Paraíba','26':'Pernambuco',
        '27':'Alagoas','28':'Sergipe','29':'Bahia','31':'Minas Gerais','32':'Espírito Santo','33':'Rio de Janeiro',
        '35':'São Paulo','41':'Paraná','42':'Santa Catarina','43':'Rio Grande do Sul','50':'Mato Grosso do Sul',
        '51':'Mato Grosso','52':'Goiás','53':'Distrito Federal'
    };

    var estado = {
        tipos: [],
        ocorrencias: [],
        selecionada: null,
        equipes: [],
        mapa: null,
        camada: null,
        malha: null,
        malhaUf: null,
        nomesMunicipios: {},
        municipioParaUf: {},
        contagemMunicipios: {},
        contagemUf: {},
        ufAtual: null,
        temporizador: null,
        mfa: null
    };

    function $(id) { return document.getElementById(id); }

    function escapeHtml(valor) {
        return String(valor === null || valor === undefined ? '' : valor)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function dataHora(ms) {
        if (!ms) return '—';
        try {
            return new Date(ms).toLocaleString('pt-BR', {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
        } catch (e) { return '—'; }
    }

    function numero(valor) {
        var n = Number(valor);
        return Number.isFinite(n) ? n.toLocaleString('pt-BR') : '0';
    }

    function token() {
        try { return localStorage.getItem('dcmt_token'); } catch (e) { return null; }
    }

    function guardarToken(valor) {
        try {
            if (valor) localStorage.setItem('dcmt_token', valor);
            else localStorage.removeItem('dcmt_token');
        } catch (e) { /* armazenamento indisponível */ }
    }

    function avisar(mensagem) {
        var el = $('toastCentral');
        if (!el) {
            el = document.createElement('div');
            el.id = 'toastCentral';
            el.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:500;max-width:420px;' +
                'background:#151f33;border:1px solid rgba(148,163,184,.3);border-left:3px solid #f9731c;' +
                'color:#f1f5f9;padding:12px 16px;border-radius:9px;font:11.5px Inter,sans-serif;' +
                'box-shadow:0 12px 34px rgba(0,0,0,.45);line-height:1.5;';
            document.body.appendChild(el);
        }
        el.textContent = mensagem;
        el.style.display = 'block';
        clearTimeout(el._t);
        el._t = setTimeout(function () { el.style.display = 'none'; }, 6000);
    }

    /* ---------------- autenticação ---------------- */

    function mostrarAuth(mensagem) {
        $('authBanner').classList.add('show');
        if (mensagem) $('authBannerText').textContent = mensagem;
        $('btnSessao').innerHTML = '<i data-lucide="user"></i> Entrar';
        if (window.lucide) lucide.createIcons();
    }

    function esconderAuth() {
        $('authBanner').classList.remove('show');
        $('btnSessao').innerHTML = '<i data-lucide="log-out"></i> Sair';
        if (window.lucide) lucide.createIcons();
    }

    function tratarSessao(resposta) {
        if (resposta && (resposta.status === 401 || resposta.status === 403)) {
            mostrarAuth(resposta.data && resposta.data.erro
                ? resposta.data.erro
                : 'Sessão inválida ou sem permissão para acessar a Central.');
            return true;
        }
        return false;
    }
    function abrirModal(id) {
        var el = $(id);
        if (!el) return;
        if (id === 'loginModal') {
            estado.mfa = null;
            if ($('mfaBloco')) $('mfaBloco').style.display = 'none';
            if ($('loginErro')) $('loginErro').classList.remove('show');
        }
        el.classList.add('show');
        if (id === 'loginModal' && !$('lUsuario').value) $('lUsuario').focus();
        if (id === 'formModal') $('cTitulo').focus();
    }

    function fecharModal(id) {
        var el = $(id);
        if (el) el.classList.remove('show');
    }

    async function entrar() {
        var usuario = $('lUsuario').value.trim();
        var senha = $('lSenha').value;
        var erroEl = $('loginErro');
        erroEl.classList.remove('show');
        if (!usuario || !senha) {
            erroEl.textContent = 'Informe usuário e senha.';
            erroEl.classList.add('show');
            return;
        }
        $('btnLogin').disabled = true;
        try {
            var r = await dcApi.login(usuario, senha);
            if (!r.ok) {
                erroEl.textContent = (r.data && r.data.erro) || 'Não foi possível entrar.';
                erroEl.classList.add('show');
                return;
            }
            if (r.data && r.data.mfaSetupRequired) {
                await iniciarMfa('setup', r.data.challengeToken);
                return;
            }
            if (r.data && r.data.mfaRequired) {
                await iniciarMfa('login', r.data.challengeToken);
                return;
            }
            concluirLogin(r.data && r.data.token);
        } catch (e) {
            erroEl.textContent = 'Falha de conexão com o servidor.';
            erroEl.classList.add('show');
        } finally {
            $('btnLogin').disabled = false;
        }
    }

    async function iniciarMfa(tipo, challengeToken) {
        estado.mfa = { tipo: tipo, challengeToken: challengeToken };
        $('mfaBloco').style.display = 'block';
        $('mfaCodigo').value = '';
        $('loginErro').classList.remove('show');
        if (tipo === 'login') {
            $('mfaInstrucoes').textContent = 'Informe o código temporário do aplicativo autenticador.';
            $('mfaSegredo').style.display = 'none';
            $('mfaCodigo').focus();
            return;
        }
        $('mfaInstrucoes').textContent = 'Configure o autenticador antes de entrar.';
        $('btnMfaConfirmar').disabled = true;
        try {
            var r = await dcApi.mfaEnroll(challengeToken);
            if (!r.ok) {
                $('loginErro').textContent = (r.data && r.data.erro) || 'Não foi possível iniciar o cadastro do MFA.';
                $('loginErro').classList.add('show');
                return;
            }
            var segredo = r.data.secret || '';
            $('mfaSegredo').style.display = 'block';
            $('mfaSegredo').innerHTML = 'Chave: <b>' + escapeHtml(segredo) + '</b><br>' +
                (r.data.otpauthUri ? 'URI: ' + escapeHtml(r.data.otpauthUri) : '');
            $('mfaInstrucoes').textContent = 'Adicione a chave ao aplicativo autenticador e informe o código de 6 dígitos.';
            $('mfaCodigo').focus();
        } catch (e) {
            $('loginErro').textContent = 'Falha de conexão ao iniciar o MFA.';
            $('loginErro').classList.add('show');
        } finally {
            $('btnMfaConfirmar').disabled = false;
        }
    }

    async function confirmarMfa() {
        if (!estado.mfa) return;
        var codigo = $('mfaCodigo').value.trim();
        var erroEl = $('loginErro');
        erroEl.classList.remove('show');
        if (!/^\d{6}$/.test(codigo)) {
            erroEl.textContent = 'Informe o código de 6 dígitos.';
            erroEl.classList.add('show');
            return;
        }
        $('btnMfaConfirmar').disabled = true;
        try {
            var r = estado.mfa.tipo === 'setup'
                ? await dcApi.mfaConfirm(estado.mfa.challengeToken, codigo)
                : await dcApi.mfaVerify(estado.mfa.challengeToken, codigo);
            if (!r.ok) {
                erroEl.textContent = (r.data && r.data.erro) || 'Código inválido.';
                erroEl.classList.add('show');
                return;
            }
            estado.mfa = null;
            concluirLogin(r.data && r.data.token);
        } catch (e) {
            erroEl.textContent = 'Falha de conexão ao validar o código.';
            erroEl.classList.add('show');
        } finally {
            $('btnMfaConfirmar').disabled = false;
        }
    }

    async function concluirLogin(novoToken) {
        guardarToken(novoToken);
        fecharModal('loginModal');
        $('lSenha').value = '';
        $('mfaBloco').style.display = 'none';
        $('mfaSegredo').style.display = 'none';
        estado.mfa = null;
        esconderAuth();
        await carregarTudo();
    }

    function sair() {
        guardarToken(null);
        estado.ocorrencias = [];
        estado.selecionada = null;
        renderTabela();
        renderDetalhe(null);
        mostrarAuth('Sessão encerrada. Entre novamente para acessar a Central.');
        $('kpiGrid').innerHTML = '';
        $('chartTipo').innerHTML = '<p class="muted">Sem dados.</p>';
        $('chartEvolucao').innerHTML = '<p class="muted">Sem dados.</p>';
        if (estado.camada) estado.camada.clearLayers();
    }

    async function entrar() {
        var usuario = $('lUsuario').value.trim();
        var senha = $('lSenha').value;
        var erroEl = $('loginErro');
        erroEl.classList.remove('show');
        if (!usuario || !senha) {
            erroEl.textContent = 'Informe usuário e senha.';
            erroEl.classList.add('show');
            return;
        }
        $('btnLogin').disabled = true;
        try {
            var r = await dcApi.login(usuario, senha);
            if (!r.ok) {
                erroEl.textContent = (r.data && r.data.erro) || 'Não foi possível entrar.';
                erroEl.classList.add('show');
                return;
            }
            if (r.data && r.data.mfaSetupRequired) {
                await iniciarMfa('setup', r.data.challengeToken);
                return;
            }
            if (r.data && r.data.mfaRequired) {
                await iniciarMfa('login', r.data.challengeToken);
                return;
            }
            concluirLogin(r.data && r.data.token);
        } catch (e) {
            erroEl.textContent = 'Falha de conexão com o servidor.';
            erroEl.classList.add('show');
        } finally {
            $('btnLogin').disabled = false;
        }
    }

    async function iniciarMfa(tipo, challengeToken) {
        estado.mfa = { tipo: tipo, challengeToken: challengeToken };
        $('mfaBloco').style.display = 'block';
        $('mfaCodigo').value = '';
        $('loginErro').classList.remove('show');
        if (tipo === 'login') {
            $('mfaInstrucoes').textContent = 'Informe o código temporário do aplicativo autenticador.';
            $('mfaSegredo').style.display = 'none';
            $('mfaCodigo').focus();
            return;
        }
        $('mfaInstrucoes').textContent = 'Configure o autenticador antes de entrar.';
        $('btnMfaConfirmar').disabled = true;
        try {
            var r = await dcApi.mfaEnroll(challengeToken);
            if (!r.ok) {
                $('loginErro').textContent = (r.data && r.data.erro) || 'Não foi possível iniciar o cadastro do MFA.';
                $('loginErro').classList.add('show');
                return;
            }
            var segredo = r.data.secret || '';
            $('mfaSegredo').style.display = 'block';
            $('mfaSegredo').innerHTML = 'Chave: <b>' + escapeHtml(segredo) + '</b><br>' +
                (r.data.otpauthUri ? 'URI: ' + escapeHtml(r.data.otpauthUri) : '');
            $('mfaInstrucoes').textContent = 'Adicione a chave ao aplicativo autenticador e informe o código de 6 dígitos.';
            $('mfaCodigo').focus();
        } catch (e) {
            $('loginErro').textContent = 'Falha de conexão ao iniciar o MFA.';
            $('loginErro').classList.add('show');
        } finally {
            $('btnMfaConfirmar').disabled = false;
        }
    }

    async function confirmarMfa() {
        if (!estado.mfa) return;
        var codigo = $('mfaCodigo').value.trim();
        var erroEl = $('loginErro');
        erroEl.classList.remove('show');
        if (!/^\d{6}$/.test(codigo)) {
            erroEl.textContent = 'Informe o código de 6 dígitos.';
            erroEl.classList.add('show');
            return;
        }
        $('btnMfaConfirmar').disabled = true;
        try {
            var r = estado.mfa.tipo === 'setup'
                ? await dcApi.mfaConfirm(estado.mfa.challengeToken, codigo)
                : await dcApi.mfaVerify(estado.mfa.challengeToken, codigo);
            if (!r.ok) {
                erroEl.textContent = (r.data && r.data.erro) || 'Código inválido.';
                erroEl.classList.add('show');
                return;
            }
            estado.mfa = null;
            concluirLogin(r.data && r.data.token);
        } catch (e) {
            erroEl.textContent = 'Falha de conexão ao validar o código.';
            erroEl.classList.add('show');
        } finally {
            $('btnMfaConfirmar').disabled = false;
        }
    }

    async function concluirLogin(novoToken) {
        guardarToken(novoToken);
        fecharModal('loginModal');
        $('lSenha').value = '';
        $('mfaBloco').style.display = 'none';
        $('mfaSegredo').style.display = 'none';
        estado.mfa = null;
        esconderAuth();
        await carregarTudo();
    }

    function sair() {
        guardarToken(null);
        estado.ocorrencias = [];
        estado.selecionada = null;
        renderTabela();
        renderDetalhe(null);
        mostrarAuth('Sessão encerrada. Entre novamente para acessar a Central.');
        $('kpiGrid').innerHTML = '';
        $('chartTipo').innerHTML = '<p class="muted">Sem dados.</p>';
        $('chartEvolucao').innerHTML = '<p class="muted">Sem dados.</p>';
        if (estado.camada) estado.camada.clearLayers();
    }

    /* ---------------- carga de dados ---------------- */

    function filtrosAtuais() {
        return {
            q: $('fBusca').value.trim(),
            tipo: $('fTipo').value,
            prioridade: $('fPrioridade').value,
            status: $('fStatus').value,
            de: $('fDe').value ? $('fDe').value + 'T00:00:00' : '',
            ate: $('fAte').value ? $('fAte').value + 'T23:59:59' : ''
        };
    }

    async function carregarTipos() {
        var r = await dcApi.centralTipos();
        if (tratarSessao(r)) return;
        if (!r.ok) { avisar((r.data && r.data.erro) || 'Falha ao carregar o catálogo de tipos.'); return; }
        estado.tipos = r.data.tipos || [];
        var selectFiltro = $('fTipo');
        var selectForm = $('cTipo');
        selectFiltro.innerHTML = '<option value="">Todos</option>' + estado.tipos
            .map(function (t) { return '<option value="' + escapeHtml(t.codigo) + '">' + escapeHtml(t.nome) + '</option>'; })
            .join('');
        selectForm.innerHTML = '<option value="">Selecione...</option>' + estado.tipos
            .map(function (t) { return '<option value="' + escapeHtml(t.codigo) + '">' + escapeHtml(t.nome) + '</option>'; })
            .join('');
    }

    async function carregarOcorrencias() {
        var r = await dcApi.centralListar(filtrosAtuais());
        if (tratarSessao(r)) { renderTabela(); return; }
        if (!r.ok) { avisar((r.data && r.data.erro) || 'Falha ao carregar ocorrências.'); return; }
        estado.ocorrencias = r.data.ocorrencias || [];
        preencherSelectsDominio(r.data);
        renderTabela();
        renderMapa();
    }

    function preencherSelectsDominio(dados) {
        var statusDisponiveis = dados.statuses || Object.keys(STATUS_LABEL);
        var selectStatus = $('fStatus');
        if (selectStatus.options.length <= 1) {
            selectStatus.innerHTML = '<option value="">Todas</option>' + statusDisponiveis
                .map(function (s) { return '<option value="' + escapeHtml(s) + '">' + escapeHtml(STATUS_LABEL[s] || s) + '</option>'; })
                .join('');
        }
        var selectPrioridade = $('fPrioridade');
        if (selectPrioridade.options.length <= 1) {
            selectPrioridade.innerHTML = '<option value="">Todas</option>' + PRIORIDADES
                .map(function (p) { return '<option value="' + p + '">' + PRIORIDADE_LABEL[p] + '</option>'; })
                .join('');
        }
        var selectForm = $('cPrioridade');
        if (selectForm.options.length <= 1) {
            selectForm.innerHTML = '<option value="">Sugerir automaticamente</option>' + PRIORIDADES
                .map(function (p) { return '<option value="' + p + '">' + PRIORIDADE_LABEL[p] + '</option>'; })
                .join('');
        }
    }

    async function carregarDashboard() {
        var r = await dcApi.centralDashboard(filtrosAtuais());
        if (tratarSessao(r)) { $('kpiGrid').innerHTML = ''; return; }
        if (!r.ok) { avisar((r.data && r.data.erro) || 'Falha ao carregar indicadores.'); return; }
        var i = r.data.indicadores;
        if (!i) { $('kpiGrid').innerHTML = ''; return; }
        renderKpis(i);
        renderGraficos(i);
    }

    async function carregarEquipes() {
        var r = await dcApi.centralEquipes();
        if (tratarSessao(r)) return;
        if (r.ok) estado.equipes = r.data.equipes || [];
    }

    async function carregarTudo() {
        await carregarTipos();
        await Promise.all([carregarOcorrencias(), carregarDashboard(), carregarEquipes()]);
        if (!estado.selecionada && estado.ocorrencias.length) {
            abrirDetalhe(estado.ocorrencias[0].id);
        }
    }

    /* ---------------- render: indicadores ---------------- */

    function kpi(cls, label, valor, sub) {
        return '<div class="kpi ' + cls + '"><div class="lbl">' + escapeHtml(label) + '</div>' +
            '<div class="val">' + escapeHtml(valor) + '</div>' +
            '<div class="sub">' + escapeHtml(sub || '') + '</div></div>';
    }

    function renderKpis(i) {
        var tempo = i.tempoMedioAtendimentoHoras === null || i.tempoMedioAtendimentoHoras === undefined
            ? '—' : numero(i.tempoMedioAtendimentoHoras) + ' h';
        $('kpiGrid').innerHTML = [
            kpi('', 'Total registrado', numero(i.total), 'ocorrências'),
            kpi('amber', 'Em andamento', numero(i.emAndamento), 'não concluídas'),
            kpi('red', 'Críticas', numero(i.criticas), 'prioridade crítica'),
            kpi('green', 'Concluídas', numero(i.concluidas), 'encerradas'),
            kpi('blue', 'Municípios afetados', numero(i.municipiosAfetados), 'com registro'),
            kpi('purple', 'Pessoas afetadas', numero(i.pessoasAfetadas), 'soma declarada'),
            kpi('amber', 'Desalojados', numero(i.desalojados), 'avaliação de danos'),
            kpi('red', 'Desabrigados', numero(i.desabrigados), 'avaliação de danos'),
            kpi('blue', 'Equipes mobilizadas', numero(i.equipesMobilizadas), 'em operação'),
            kpi('', 'Tempo médio', tempo, 'até a conclusão')
        ].join('');
    }

    function barras(itens, rotulo) {
        var lista = (itens || []).slice(0, 8);
        if (!lista.length) return '<p class="muted">Sem dados.</p>';
        var max = lista.reduce(function (acc, item) { return Math.max(acc, Number(item.total || 0)); }, 1);
        return lista.map(function (item) {
            var total = Number(item.total || 0);
            var nome = rotulo ? rotulo(item) : (item.nome || item.chave || '—');
            var pct = Math.max(3, Math.round((total / max) * 100));
            return '<div class="bar-row"><span class="name" title="' + escapeHtml(nome) + '">' + escapeHtml(nome) + '</span>' +
                '<span class="track"><span class="fill" style="width:' + pct + '%"></span></span>' +
                '<span class="val">' + total + '</span></div>';
        }).join('');
    }

    function renderGraficos(i) {
        $('chartTipo').innerHTML = barras(i.porTipo, function (t) { return t.nome || t.chave; });
        $('chartEvolucao').innerHTML = barras(i.evolucao, function (e) {
            var partes = String(e.dia || '').split('-');
            return partes.length === 3 ? partes[2] + '/' + partes[1] : e.dia;
        });
    }

    /* ---------------- render: tabela ---------------- */

    function badgePrioridade(p) {
        if (!p) return '<span class="badge sem">Sem prioridade</span>';
        var cls = String(p).toLowerCase();
        return '<span class="badge ' + cls + '">' + escapeHtml(PRIORIDADE_LABEL[p] || p) + '</span>';
    }

    function badgeStatus(s) {
        var cls = String(s || '').toLowerCase();
        return '<span class="badge status ' + cls + '">' + escapeHtml(STATUS_LABEL[s] || s) + '</span>';
    }

    function renderTabela() {
        var corpo = $('tabelaCorpo');
        var total = estado.ocorrencias.length;
        $('tabelaResumo').textContent = total ? total + ' registro(s)' : 'nenhum registro';
        if (!total) {
            corpo.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma ocorrência encontrada com os filtros atuais.</td></tr>';
            return;
        }
        corpo.innerHTML = estado.ocorrencias.map(function (o) {
            var sel = estado.selecionada && estado.selecionada.id === o.id ? ' class="sel"' : '';
            return '<tr data-id="' + escapeHtml(o.id) + '"' + sel + ' tabindex="0">' +
                '<td><span class="proto">' + escapeHtml(o.protocolo || '—') + '</span></td>' +
                '<td><span class="titulo">' + escapeHtml(o.titulo) + '</span>' +
                '<span class="sub">' + escapeHtml(o.tipoNome || o.tipo) + ' · ' + escapeHtml(VERIFICACAO_LABEL[o.verificacao] || o.verificacao) + '</span></td>' +
                '<td>' + escapeHtml(o.municipio || '—') + '</td>' +
                '<td>' + badgePrioridade(o.prioridade) + '</td>' +
                '<td>' + badgeStatus(o.status) + '</td>' +
                '<td>' + numero(o.pessoasAfetadas) + '</td>' +
                '<td>' + escapeHtml(dataHora(o.criadaEm)) + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ---------------- render: mapa ---------------- */

    function corPrioridade(p) {
        if (p === 'CRITICA') return '#ef4444';
        if (p === 'ALTA') return '#f9731c';
        if (p === 'MODERADA') return '#fbbf24';
        if (p === 'BAIXA') return '#22c55e';
        return '#94a3b8';
    }

    function iniciarMapa() {
        if (!window.L || estado.mapa) return;
        estado.mapa = L.map('mapaCentral', { zoomControl: true }).setView([-14.235, -51.925], 4);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 18,
            subdomains: 'abcd'
        }).addTo(estado.mapa);
        estado.camada = L.layerGroup().addTo(estado.mapa);
        estado.mapa.on('click', function (evento) {
            if (!$('formModal').classList.contains('show')) return;
            $('cLatitude').value = evento.latlng.lat.toFixed(6);
            $('cLongitude').value = evento.latlng.lng.toFixed(6);
            $('gpsStatus').textContent = 'Coordenadas definidas pelo mapa: ' +
                evento.latlng.lat.toFixed(5) + ', ' + evento.latlng.lng.toFixed(5);
        });
    }

    function renderMapa() {
        atualizarContagens();
        if (!estado.mapa || !estado.camada) return;
        estado.camada.clearLayers();
        var pontos = estado.ocorrencias.filter(function (o) {
            return o.latitude !== null && o.latitude !== undefined && o.longitude !== null && o.longitude !== undefined;
        });
        pontos.forEach(function (o) {
            var marcador = L.circleMarker([o.latitude, o.longitude], {
                radius: o.prioridade === 'CRITICA' ? 9 : 7,
                color: corPrioridade(o.prioridade),
                weight: 2,
                fillColor: corPrioridade(o.prioridade),
                fillOpacity: 0.35
            }).addTo(estado.camada);
            marcador.bindPopup(
                '<b>' + escapeHtml(o.protocolo || '') + '</b><br>' +
                escapeHtml(o.titulo) + '<br>' +
                '<span>' + escapeHtml(o.municipio || '') + ' · ' + escapeHtml(STATUS_LABEL[o.status] || o.status) + '</span>'
            );
            marcador.on('click', function () { abrirDetalhe(o.id); });
        });
        if (pontos.length) {
            estado.mapa.fitBounds(L.latLngBounds(pontos.map(function (o) { return [o.latitude, o.longitude]; })), { padding: [26, 26], maxZoom: 12 });
        }
    }

    /* ---------------- detalhe ---------------- */

    async function abrirDetalhe(id) {
        var r = await dcApi.centralDetalhe(id);
        if (tratarSessao(r)) return;
        if (!r.ok) { avisar((r.data && r.data.erro) || 'Falha ao abrir a ocorrência.'); return; }
        estado.selecionada = r.data.ocorrencia;
        renderTabela();
        renderDetalhe(estado.selecionada);
    }

    function campoDl(rotulo, valor) {
        return '<dt>' + escapeHtml(rotulo) + '</dt><dd>' + escapeHtml(valor || '—') + '</dd>';
    }

    function renderDetalhe(o) {
        var painel = $('detailPanel');
        if (!o) {
            painel.innerHTML = '<div class="detail-empty"><i data-lucide="mouse-pointer-click" style="font-size:26px;color:var(--accent)"></i>' +
                '<p style="margin-top:10px">Selecione uma ocorrência na tabela para ver o detalhe completo, a avaliação de danos e o histórico de decisões.</p></div>';
            if (window.lucide) lucide.createIcons();
            return;
        }
        var d = o.danos || {};
        var danosHtml = [
            ['Residências atingidas', d.residenciasAtingidas],
            ['Edificações danificadas', d.edificacoesDanificadas],
            ['Pessoas feridas', d.pessoasFeridas],
            ['Óbitos', d.obitos],
            ['Desabrigados', d.desabrigados],
            ['Desalojados', d.desalojados],
            ['Infraestrutura pública', d.infraestruturaPublica],
            ['Pontes / estradas', d.pontesEstradas],
            ['Equipamentos públicos', d.equipamentosPublicos],
            ['Agricultura / pecuária', d.agriculturaPecuaria]
        ].map(function (par) {
            return '<div class="dano"><div class="n">' + numero(par[1] || 0) + '</div><div class="l">' + escapeHtml(par[0]) + '</div></div>';
        }).join('');

        var historico = (o.historico || []).slice().reverse().map(function (h) {
            return '<li><div class="t">' + escapeHtml(dataHora(h.alteradoEm)) + ' · ' + escapeHtml(h.usuario || 'sistema') + '</div>' +
                '<div class="s">' + escapeHtml(STATUS_LABEL[h.statusNovo] || h.statusNovo) + '</div>' +
                (h.nota ? '<div class="nota">' + escapeHtml(h.nota) + '</div>' : '') + '</li>';
        }).join('') || '<li class="muted">Sem histórico.</li>';

        var mobilizacoes = (o.mobilizacoes || []).map(function (m) {
            return '<div class="dano" style="margin-bottom:6px"><div class="l">' + escapeHtml(m.equipeNome || 'Equipe') + '</div>' +
                '<div class="n" style="font-size:12px">' + escapeHtml(MOBILIZACAO_LABEL[m.status] || m.status) + '</div>' +
                '<div class="l">' + escapeHtml(m.atividades || '') + '</div></div>';
        }).join('') || '<p class="muted">Nenhuma equipe mobilizada.</p>';

        var anexos = (o.anexos || []).map(function (a) {
            var url = /^https?:\/\//i.test(a.url) ? a.url : '';
            return '<div style="font-size:10.5px;margin-bottom:4px;word-break:break-all">' +
                (url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" style="color:var(--blue)">' + escapeHtml(a.nome) + '</a>'
                    : escapeHtml(a.nome)) +
                ' <span class="muted">(' + escapeHtml(a.mimeType || '') + ')</span></div>';
        }).join('') || '<p class="muted">Nenhum anexo registrado.</p>';

        var equipesOpcoes = estado.equipes.map(function (e) {
            return '<option value="' + escapeHtml(e.id) + '">' + escapeHtml(e.nome) + '</option>';
        }).join('');

        var dadosRestritos = o.dadosRestritos && Object.keys(o.dadosRestritos).length
            ? '<div class="detail-sec"><h4><i data-lucide="lock"></i> Dados restritos (LGPD)</h4><div class="dl">' +
              Object.keys(o.dadosRestritos).map(function (k) {
                  return campoDl(k, typeof o.dadosRestritos[k] === 'object' ? JSON.stringify(o.dadosRestritos[k]) : o.dadosRestritos[k]);
              }).join('') + '</div></div>'
            : '';

        painel.innerHTML =
            '<div class="detail-head">' +
            '<div class="proto">' + escapeHtml(o.protocolo || '') + '</div>' +
            '<h3>' + escapeHtml(o.titulo) + '</h3>' +
            '<div class="meta">' + badgePrioridade(o.prioridade) + badgeStatus(o.status) +
            '<span class="badge sem">' + escapeHtml(VERIFICACAO_LABEL[o.verificacao] || o.verificacao) + '</span></div>' +
            '</div>' +
            '<div class="detail-sec"><h4><i data-lucide="info"></i> Dados do registro</h4><div class="dl">' +
            campoDl('Tipo', o.tipoNome || o.tipo) +
            campoDl('Município', o.municipio) +
            campoDl('Bairro', o.bairro) +
            campoDl('Endereço', o.endereco) +
            campoDl('Coordenadas', o.latitude !== null && o.latitude !== undefined
                ? Number(o.latitude).toFixed(5) + ', ' + Number(o.longitude).toFixed(5) : '') +
            campoDl('Registrada em', dataHora(o.criadaEm)) +
            campoDl('Atualizada em', dataHora(o.atualizadaEm)) +
            campoDl('Pessoas afetadas', numero(o.pessoasAfetadas)) +
            campoDl('Fonte', o.fonte) +
            '</div></div>' +
            '<div class="detail-sec"><h4><i data-lucide="file-text"></i> Descrição</h4>' +
            '<p style="font-size:11px;line-height:1.65;color:#cbd5e1;white-space:pre-wrap">' + escapeHtml(o.descricao) + '</p>' +
            (o.causaProvavel ? '<p class="muted" style="margin-top:8px"><b>Causa provável:</b> ' + escapeHtml(o.causaProvavel) + '</p>' : '') +
            (o.necessidades ? '<p class="muted" style="margin-top:6px"><b>Necessidades:</b> ' + escapeHtml(o.necessidades) + '</p>' : '') +
            '</div>' +
            '<div class="detail-sec"><h4><i data-lucide="house-damage"></i> Avaliação de danos</h4><div class="danos-grid">' + danosHtml + '</div>' +
            (d.observacoes ? '<p class="muted" style="margin-top:8px">' + escapeHtml(d.observacoes) + '</p>' : '') + '</div>' +
            dadosRestritos +
            '<div class="detail-sec"><h4><i data-lucide="git-branch"></i> Decisão operacional</h4>' +
            '<div class="field" style="margin-bottom:8px"><label>Nova situação</label><select id="acaoStatus">' +
            Object.keys(STATUS_LABEL).filter(function (s) { return s !== 'ESCALADA'; }).map(function (s) {
                return '<option value="' + s + '">' + escapeHtml(STATUS_LABEL[s]) + '</option>';
            }).join('') + '</select></div>' +
            '<div class="field" style="margin-bottom:8px"><label>Justificativa (obrigatória para concluir/arquivar)</label>' +
            '<textarea id="acaoJustificativa" maxlength="1000" style="min-height:56px"></textarea></div>' +
            '<button class="btn primary" id="btnAplicarStatus"><i data-lucide="check-check"></i> Registrar mudança</button>' +
            '</div>' +
            '<div class="detail-sec"><h4><i data-lucide="flag"></i> Prioridade</h4>' +
            '<p class="muted" style="margin-bottom:6px">Sugestão automática: <b>' +
            escapeHtml(o.prioridadeSugerida ? (PRIORIDADE_LABEL[o.prioridadeSugerida] || o.prioridadeSugerida) : '—') + '</b>' +
            (o.prioridadeSugeridaMotivos && o.prioridadeSugeridaMotivos.length
                ? ' — ' + escapeHtml(o.prioridadeSugeridaMotivos.join(' ')) : '') + '</p>' +
            '<div class="btn-row"><select id="acaoPrioridade" class="btn" style="padding:7px 9px">' +
            PRIORIDADES.map(function (p) {
                return '<option value="' + p + '"' + (o.prioridade === p ? ' selected' : '') + '>' + PRIORIDADE_LABEL[p] + '</option>';
            }).join('') + '</select>' +
            '<button class="btn" id="btnAplicarPrioridade"><i data-lucide="check"></i> Confirmar prioridade</button></div>' +
            '</div>' +
            '<div class="detail-sec"><h4><i data-lucide="users"></i> Equipes mobilizadas</h4>' + mobilizacoes +
            (equipesOpcoes ? '<div class="btn-row" style="margin-top:8px"><select id="mobilizarEquipe" class="btn" style="padding:7px 9px">' +
                equipesOpcoes + '</select><button class="btn" id="btnMobilizar"><i data-lucide="send"></i> Mobilizar</button></div>'
                : '<p class="hint">Cadastre uma equipe pela API para habilitar a mobilização.</p>') +
            '</div>' +
            '<div class="detail-sec"><h4><i data-lucide="paperclip"></i> Anexos</h4>' + anexos + '</div>' +
            '<div class="detail-sec"><h4><i data-lucide="history"></i> Histórico</h4><ul class="timeline">' + historico + '</ul></div>';

        if (window.lucide) lucide.createIcons();
    }

    /* ---------------- ações do detalhe ---------------- */

    async function aplicarStatus() {
        if (!estado.selecionada) return;
        var status = $('acaoStatus').value;
        var justificativa = $('acaoJustificativa').value.trim();
        var r = await dcApi.centralAtualizar(estado.selecionada.id, { status: status, justificativa: justificativa });
        if (tratarSessao(r)) return;
        if (!r.ok) { avisar((r.data && r.data.erro) || 'Não foi possível atualizar a situação.'); return; }
        estado.selecionada = r.data.ocorrencia;
        renderDetalhe(estado.selecionada);
        await Promise.all([carregarOcorrencias(), carregarDashboard()]);
        avisar('Situação atualizada e registrada no histórico.');
    }

    async function aplicarPrioridade() {
        if (!estado.selecionada) return;
        var prioridade = $('acaoPrioridade').value;
        var r = await dcApi.centralAtualizar(estado.selecionada.id, { prioridade: prioridade });
        if (tratarSessao(r)) return;
        if (!r.ok) { avisar((r.data && r.data.erro) || 'Não foi possível confirmar a prioridade.'); return; }
        estado.selecionada = r.data.ocorrencia;
        renderDetalhe(estado.selecionada);
        await Promise.all([carregarOcorrencias(), carregarDashboard()]);
        avisar('Prioridade confirmada pelo operador.');
    }

    async function mobilizar() {
        if (!estado.selecionada) return;
        var equipeId = $('mobilizarEquipe').value;
        if (!equipeId) { avisar('Selecione uma equipe.'); return; }
        var r = await dcApi.centralMobilizar({
            equipeId: equipeId,
            ocorrenciaId: estado.selecionada.id,
            atividades: 'Mobilização registrada pela Central de Ocorrências.'
        });
        if (tratarSessao(r)) return;
        if (!r.ok) { avisar((r.data && r.data.erro) || 'Não foi possível mobilizar a equipe.'); return; }
        await abrirDetalhe(estado.selecionada.id);
        await carregarDashboard();
        avisar('Equipe mobilizada.');
    }

    /* ---------------- formulário ---------------- */

    function coletarFormulario() {
        var danos = {
            residenciasAtingidas: Number($('dResidencias').value || 0),
            edificacoesDanificadas: Number($('dEdificacoes').value || 0),
            pessoasFeridas: Number($('dFeridos').value || 0),
            obitos: Number($('dObitos').value || 0),
            desabrigados: Number($('dDesabrigados').value || 0),
            desalojados: Number($('dDesalojados').value || 0),
            infraestruturaPublica: Number($('dInfra').value || 0),
            pontesEstradas: Number($('dPontes').value || 0),
            equipamentosPublicos: Number($('dEquipamentos').value || 0),
            agriculturaPecuaria: Number($('dAgricultura').value || 0)
        };
        var prejuizo = $('dPrejuizo').value;
        if (prejuizo !== '') danos.prejuizoEstimado = Number(prejuizo);
        var latitude = $('cLatitude').value;
        var longitude = $('cLongitude').value;
        return {
            titulo: $('cTitulo').value.trim(),
            descricao: $('cDescricao').value.trim(),
            tipo: $('cTipo').value,
            verificacao: $('cVerificacao').value,
            municipio: $('cMunicipio').value.trim(),
            bairro: $('cBairro').value.trim(),
            endereco: $('cEndereco').value.trim(),
            causaProvavel: $('cCausa').value.trim(),
            necessidades: $('cNecessidades').value.trim(),
            pessoasAfetadas: Number($('cAfetadas').value || 0),
            prioridade: $('cPrioridade').value || undefined,
            latitude: latitude === '' ? undefined : Number(latitude),
            longitude: longitude === '' ? undefined : Number(longitude),
            danos: danos
        };
    }

    function validarFormulario(dados) {
        if (!dados.titulo || dados.titulo.length < 5) return 'Informe um título com ao menos 5 caracteres.';
        if (!dados.tipo) return 'Selecione o tipo de ocorrência.';
        if (!dados.municipio) return 'Informe o município.';
        if (!dados.descricao || dados.descricao.length < 10) return 'Descreva a ocorrência com ao menos 10 caracteres.';
        if ((dados.latitude === undefined) !== (dados.longitude === undefined)) return 'Informe latitude e longitude juntas.';
        return null;
    }

    async function salvarOcorrencia() {
        var erroEl = $('formErro');
        erroEl.classList.remove('show');
        var dados = coletarFormulario();
        var problema = validarFormulario(dados);
        if (problema) {
            erroEl.textContent = problema;
            erroEl.classList.add('show');
            return;
        }
        $('btnSalvar').disabled = true;
        try {
            var r = await dcApi.centralCriar(dados);
            if (tratarSessao(r)) { fecharModal('formModal'); return; }
            if (!r.ok) {
                erroEl.textContent = (r.data && (r.data.erro + (r.data.codigo ? ' (' + r.data.codigo + ')' : ''))) || 'Não foi possível registrar.';
                erroEl.classList.add('show');
                return;
            }
            var criada = r.data.ocorrencia;
            fecharModal('formModal');
            limparFormulario();
            await Promise.all([carregarOcorrencias(), carregarDashboard()]);
            await abrirDetalhe(criada.id);
            avisar('Ocorrência ' + (criada.protocolo || '') + ' registrada.');
        } catch (e) {
            erroEl.textContent = 'Falha de conexão. Tente novamente.';
            erroEl.classList.add('show');
        } finally {
            $('btnSalvar').disabled = false;
        }
    }

    function limparFormulario() {
        $('formOcorrencia').reset();
        $('formErro').classList.remove('show');
        $('gpsStatus').textContent = 'Clique no mapa para preencher as coordenadas.';
    }

    async function carregarMunicipios() {
        try {
            var r = await fetch('/api/ibge/municipios?uf=51');
            if (!r.ok) return;
            var lista = await r.json();
            if (!Array.isArray(lista)) return;
            $('listaMunicipios').innerHTML = lista.map(function (m) {
                return '<option value="' + escapeHtml(m.nome) + '"></option>';
            }).join('');
            estado.nomesMunicipios = {};
            lista.forEach(function (m) {
                if (m && m.id != null) estado.nomesMunicipios[String(m.id)] = m.nome;
            });
        } catch (e) { /* datalist é conveniência */ }
    }

    function corChoropleth(n, escala) {
        if (!n) return 'rgba(56,189,248,.06)';
        if (escala === 'uf') {
            if (n >= 20) return 'rgba(239,68,68,.5)';
            if (n >= 10) return 'rgba(249,115,22,.45)';
            if (n >= 3) return 'rgba(251,191,36,.4)';
            return 'rgba(34,197,94,.35)';
        }
        if (n >= 10) return 'rgba(239,68,68,.45)';
        if (n >= 5) return 'rgba(249,115,22,.4)';
        if (n >= 2) return 'rgba(251,191,36,.35)';
        return 'rgba(34,197,94,.3)';
    }

    function estiloUf(feature) {
        var uf = feature && feature.properties ? String(feature.properties.codarea) : '';
        var n = estado.contagemUf[uf] || 0;
        return { color: 'rgba(56,189,248,.6)', weight: 1, fillColor: corChoropleth(n, 'uf'), fillOpacity: 1 };
    }

    function estiloMunicipio(feature) {
        var codigo = feature && feature.properties ? feature.properties.codarea : '';
        var nome = estado.nomesMunicipios[String(codigo)] || '';
        var n = estado.contagemMunicipios[nome] || 0;
        return { color: 'rgba(56,189,248,.55)', weight: 1, fillColor: corChoropleth(n), fillOpacity: 1 };
    }

    function atualizarContagens() {
        var porMunicipio = {};
        var porUf = {};
        (estado.ocorrencias || []).forEach(function (o) {
            if (o.municipio) {
                porMunicipio[o.municipio] = (porMunicipio[o.municipio] || 0) + 1;
                var uf = estado.municipioParaUf[o.municipio];
                if (uf) porUf[uf] = (porUf[uf] || 0) + 1;
            }
        });
        estado.contagemMunicipios = porMunicipio;
        estado.contagemUf = porUf;
        if (estado.malha) estado.malha.setStyle(estado.ufAtual ? estiloMunicipio : estiloUf);
    }

    async function carregarMapaMunicipioUf() {
        if (Object.keys(estado.municipioParaUf).length) return;
        try {
            var ufs = Object.keys(UF_NOMES);
            var respostas = await Promise.all(ufs.map(function (uf) {
                return fetch('/api/ibge/municipios?uf=' + uf).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
            }));
            respostas.forEach(function (lista, idx) {
                var uf = ufs[idx];
                if (!Array.isArray(lista)) return;
                lista.forEach(function (m) {
                    if (m && m.nome) estado.municipioParaUf[m.nome] = uf;
                });
            });
        } catch (e) { /* mapa de municípios é conveniência */ }
    }

    async function carregarMalhaEstados() {
        if (estado.malhaUf) return estado.malhaUf;
        $('malhaStatus').textContent = 'Carregando estados (IBGE)...';
        try {
            var r = await fetch('/api/ibge/malhas/estados');
            if (!r.ok) throw new Error('IBGE indisponível');
            var geojson = await r.json();
            if (!geojson || !Array.isArray(geojson.features)) throw new Error('Malha inválida');
            estado.malhaUf = L.geoJSON(geojson, {
                style: estiloUf,
                onEachFeature: function (feature, layer) {
                    var uf = feature && feature.properties ? String(feature.properties.codarea) : '';
                    var nome = UF_NOMES[uf] || ('UF ' + uf);
                    layer.bindTooltip(function () {
                        var n = estado.contagemUf[uf] || 0;
                        return '<b>' + escapeHtml(nome) + '</b><br>' + n + ' ocorrência(s)<br><span style="color:#94a3b8;font-size:9px">Clique para ver municípios</span>';
                    }, { sticky: true, className: 'ibge-tooltip' });
                    layer.on('mouseover', function () { layer.setStyle({ weight: 2, color: '#f9731c' }); });
                    layer.on('mouseout', function () { layer.setStyle({ weight: 1, color: 'rgba(56,189,248,.6)' }); });
                    layer.on('click', function () { drillDown(uf, layer); });
                }
            });
            $('malhaStatus').textContent = geojson.features.length + ' estados (IBGE)';
            return estado.malhaUf;
        } catch (e) {
            $('malhaStatus').textContent = 'Malha IBGE indisponível.';
            return null;
        }
    }

    async function carregarMalhaMunicipios(uf) {
        $('malhaStatus').textContent = 'Carregando municípios de ' + (UF_NOMES[uf] || uf) + '...';
        try {
            /* nomes do UF */
            var lista = [];
            try {
                var rm = await fetch('/api/ibge/municipios?uf=' + uf);
                if (rm.ok) lista = await rm.json();
            } catch (e) { lista = []; }
            if (Array.isArray(lista)) {
                lista.forEach(function (m) {
                    if (m && m.id != null) estado.nomesMunicipios[String(m.id)] = m.nome;
                });
            }
            var r = await fetch('/api/ibge/malhas/estados/' + uf);
            if (!r.ok) throw new Error('IBGE indisponível');
            var geojson = await r.json();
            if (!geojson || !Array.isArray(geojson.features)) throw new Error('Malha inválida');
            var camada = L.geoJSON(geojson, {
                style: estiloMunicipio,
                onEachFeature: function (feature, layer) {
                    var codigo = feature && feature.properties ? feature.properties.codarea : '';
                    var nome = estado.nomesMunicipios[String(codigo)] || ('Município ' + codigo);
                    layer.bindTooltip(function () {
                        var n = estado.contagemMunicipios[nome] || 0;
                        return '<b>' + escapeHtml(nome) + '</b><br>' + n + ' ocorrência(s)';
                    }, { sticky: true, className: 'ibge-tooltip' });
                    layer.on('mouseover', function () { layer.setStyle({ weight: 2, color: '#f9731c' }); });
                    layer.on('mouseout', function () { layer.setStyle({ weight: 1, color: 'rgba(56,189,248,.55)' }); });
                }
            });
            $('malhaStatus').textContent = geojson.features.length + ' municípios · ' + (UF_NOMES[uf] || uf);
            return camada;
        } catch (e) {
            $('malhaStatus').textContent = 'Malha municipal indisponível.';
            return null;
        }
    }

    async function drillDown(uf, layer) {
        if (!estado.mapa) return;
        estado.ufAtual = uf;
        if (estado.malha) estado.mapa.removeLayer(estado.malha);
        estado.malha = null;
        var camada = await carregarMalhaMunicipios(uf);
        if (!camada) { estado.ufAtual = null; return; }
        estado.malha = camada;
        camada.addTo(estado.mapa);
        try {
            if (layer && layer.getBounds) estado.mapa.fitBounds(layer.getBounds(), { padding: [20, 20], maxZoom: 9 });
        } catch (e) {}
        var botao = $('btnMalhaIbge');
        if (botao) { botao.textContent = 'Voltar ao Brasil'; botao.classList.remove('ghost'); botao.classList.add('primary'); }
    }

    async function voltarBrasil() {
        if (!estado.mapa) return;
        if (estado.malha) estado.mapa.removeLayer(estado.malha);
        estado.malha = null;
        estado.ufAtual = null;
        var camada = await carregarMalhaEstados();
        if (camada) { estado.malha = camada; camada.addTo(estado.mapa); }
        estado.mapa.setView([-14.235, -51.925], 4);
        var botao = $('btnMalhaIbge');
        if (botao) { botao.innerHTML = '<i data-lucide="layers"></i> Estados (IBGE)'; botao.classList.remove('primary'); botao.classList.add('ghost'); }
        if (window.lucide) lucide.createIcons();
        if ($('malhaStatus')) $('malhaStatus').textContent = '27 estados (IBGE)';
    }

    async function toggleMalhaIbge() {
        if (!estado.mapa) return;
        if (estado.ufAtual) { await voltarBrasil(); return; }
        var botao = $('btnMalhaIbge');
        if (estado.malha) {
            estado.mapa.removeLayer(estado.malha);
            estado.malha = null;
            botao.classList.remove('primary');
            botao.classList.add('ghost');
            $('malhaStatus').textContent = '';
            return;
        }
        var camada = await carregarMalhaEstados();
        if (!camada) return;
        estado.malha = camada;
        camada.addTo(estado.mapa);
        botao.classList.remove('ghost');
        botao.classList.add('primary');
    }

    function usarGps() {
        if (!navigator.geolocation) {
            $('gpsStatus').textContent = 'GPS indisponível neste navegador.';
            return;
        }
        $('gpsStatus').textContent = 'Obtendo coordenadas...';
        navigator.geolocation.getCurrentPosition(function (pos) {
            $('cLatitude').value = pos.coords.latitude.toFixed(6);
            $('cLongitude').value = pos.coords.longitude.toFixed(6);
            $('gpsStatus').textContent = 'Localização capturada: ' +
                pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5);
        }, function () {
            $('gpsStatus').textContent = 'Não foi possível obter a localização.';
        }, { enableHighAccuracy: true, timeout: 10000 });
    }

    /* ---------------- relógio ---------------- */

    function relogio() {
        var agora = new Date();
        $('clock').textContent = agora.toLocaleTimeString('pt-BR');
        $('dateStr').textContent = agora.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
    }

    /* ---------------- eventos ---------------- */

    function ligarEventos() {
        $('btnFiltrar').addEventListener('click', function () { carregarOcorrencias(); carregarDashboard(); });
        $('fBusca').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { carregarOcorrencias(); carregarDashboard(); }
        });
        ['fTipo', 'fPrioridade', 'fStatus', 'fDe', 'fAte'].forEach(function (id) {
            $(id).addEventListener('change', function () { carregarOcorrencias(); carregarDashboard(); });
        });

        $('tabelaCorpo').addEventListener('click', function (e) {
            var linha = e.target.closest('tr[data-id]');
            if (linha) abrirDetalhe(linha.getAttribute('data-id'));
        });
        $('tabelaCorpo').addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            var linha = e.target.closest('tr[data-id]');
            if (linha) { e.preventDefault(); abrirDetalhe(linha.getAttribute('data-id')); }
        });

        $('btnMalhaIbge').addEventListener('click', toggleMalhaIbge);
        $('btnNova').addEventListener('click', function () {
            abrirModal('formModal');
        });
        $('btnSalvar').addEventListener('click', salvarOcorrencia);
        $('btnGps').addEventListener('click', usarGps);

        $('btnSessao').addEventListener('click', function () {
            if (token()) sair();
            else abrirModal('loginModal');
        });
        $('btnEntrarBanner').addEventListener('click', function () { abrirModal('loginModal'); });
        $('btnLogin').addEventListener('click', entrar);
        $('btnMfaConfirmar').addEventListener('click', confirmarMfa);
        $('mfaCodigo').addEventListener('keydown', function (e) { if (e.key === 'Enter') confirmarMfa(); });
        $('lSenha').addEventListener('keydown', function (e) { if (e.key === 'Enter') entrar(); });
        $('lUsuario').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('lSenha').focus(); });

        document.querySelectorAll('[data-close]').forEach(function (botao) {
            botao.addEventListener('click', function () { fecharModal(botao.getAttribute('data-close')); });
        });
        document.querySelectorAll('.modal').forEach(function (modal) {
            modal.addEventListener('click', function (e) { if (e.target === modal) fecharModal(modal.id); });
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.show').forEach(function (m) { fecharModal(m.id); });
            }
        });

        /* Delegação para os controles do painel de detalhe. */
        $('detailPanel').addEventListener('click', function (e) {
            if (e.target.closest('#btnAplicarStatus')) aplicarStatus();
            else if (e.target.closest('#btnAplicarPrioridade')) aplicarPrioridade();
            else if (e.target.closest('#btnMobilizar')) mobilizar();
        });
    }

    /* ---------------- inicialização ---------------- */

    async function iniciar() {
        ligarEventos();
        await carregarMunicipios();
        await carregarMapaMunicipioUf();
        iniciarMapa();
        await carregarMalhaEstados().then(function (camada) {
            if (camada && estado.mapa) {
                estado.malha = camada;
                camada.addTo(estado.mapa);
                var botao = $('btnMalhaIbge');
                if (botao) { botao.classList.remove('ghost'); botao.classList.add('primary'); }
                if ($('malhaStatus')) $('malhaStatus').textContent = '27 estados (IBGE)';
            }
        }).catch(function () {});
        relogio();
        setInterval(relogio, 1000);

        await carregarTudo();
        estado.temporizador = setInterval(function () {
            if (document.hidden) return;
            carregarOcorrencias();
            carregarDashboard();
        }, 60000);
        $('liveBadge').style.display = 'flex';
    }

    document.addEventListener('DOMContentLoaded', iniciar);
})();

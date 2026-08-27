// Esta função roda no servidor do Netlify (nunca no navegador do cliente),
// então o token de acesso fica protegido e nunca aparece pra quem visualiza o dashboard.
//
// A partir desta versão, o dashboard é organizado por FASE da campanha
// (Fase 1, Fase 2, Fase 3), identificada pelo nome da campanha na Meta
// (ex: "[Fase 1]", "[Fase 02]", "[Fase 3]"), em vez de por objetivo.

exports.handler = async function (event, context) {
  const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID; // formato: act_1234567890
  const API_VERSION = "v21.0";

  if (!ACCESS_TOKEN || !AD_ACCOUNT_ID) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error:
          "Configuração incompleta: defina META_ACCESS_TOKEN e META_AD_ACCOUNT_ID nas variáveis de ambiente do Netlify.",
      }),
    };
  }

  try {
    // 1. Busca todas as campanhas e identifica a qual Fase cada uma pertence,
    // com base no nome da campanha.
    const campaignsUrl = `https://graph.facebook.com/${API_VERSION}/${AD_ACCOUNT_ID}/campaigns?fields=id,name,status&limit=200&access_token=${ACCESS_TOKEN}`;
    const campaignsRes = await fetch(campaignsUrl);
    const campaignsData = await campaignsRes.json();

    if (campaignsData.error) {
      return { statusCode: 500, body: JSON.stringify({ error: campaignsData.error.message }) };
    }

    const campaigns = campaignsData.data || [];
    const idsPorFase = { fase1: [], fase2: [], fase3: [] };

    campaigns.forEach((c) => {
      const fase = detectarFase(c.name);
      if (fase) idsPorFase[fase].push(c.id);
    });

    // 2. Busca os insights de cada fase, com os campos específicos que cada uma precisa.
    // Período: últimos 7 dias (mesmo padrão usado no resto do dashboard).
    const fase1Rows = await buscarInsights(
      idsPorFase.fase1,
      "spend,impressions,inline_link_clicks,actions",
      AD_ACCOUNT_ID,
      API_VERSION,
      ACCESS_TOKEN
    );
    const fase2Rows = await buscarInsights(
      idsPorFase.fase2,
      "spend,impressions,actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p95_watched_actions",
      AD_ACCOUNT_ID,
      API_VERSION,
      ACCESS_TOKEN
    );
    const fase3Rows = await buscarInsights(
      idsPorFase.fase3,
      "spend,impressions,reach,actions",
      AD_ACCOUNT_ID,
      API_VERSION,
      ACCESS_TOKEN
    );

    const fase1 = montarFase1(fase1Rows);
    const fase2 = montarFase2(fase2Rows);
    const fase3 = montarFase3(fase3Rows);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        atualizado_em: new Date().toISOString(),
        fase1,
        fase2,
        fase3,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// Identifica a fase pelo nome da campanha. Aceita "Fase 1", "Fase 01", "Fase 2",
// "Fase 02", "Fase 3", "Fase 03", em qualquer posição do nome, maiúsculo ou minúsculo.
function detectarFase(nome) {
  if (!nome) return null;
  const n = nome.toLowerCase();
  if (/fase\s*0?1\b/.test(n)) return "fase1";
  if (/fase\s*0?2\b/.test(n)) return "fase2";
  if (/fase\s*0?3\b/.test(n)) return "fase3";
  return null;
}

async function buscarInsights(ids, fields, adAccountId, apiVersion, accessToken) {
  if (!ids.length) return [];
  const filtering = encodeURIComponent(
    JSON.stringify([{ field: "campaign.id", operator: "IN", value: ids }])
  );
  const url = `https://graph.facebook.com/${apiVersion}/${adAccountId}/insights?level=campaign&date_preset=last_7d&filtering=${filtering}&fields=${fields}&access_token=${accessToken}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.data || [];
}

function somaCampo(rows, campo) {
  return rows.reduce((acc, r) => acc + parseFloat(r[campo] || 0), 0);
}

// Soma valores de "actions" (o array de resultados que a Meta devolve) filtrando
// por tipo de ação. Usado para leads, conversas de mensagem, seguidores, etc.
function valorDeAction(rows, tiposAceitos) {
  let total = 0;
  rows.forEach((r) => {
    (r.actions || []).forEach((a) => {
      if (tiposAceitos.includes(a.action_type)) total += parseInt(a.value || 0, 10);
    });
  });
  return total;
}

// Soma campos de vídeo, que vêm como array (ex: video_p25_watched_actions).
function valorDeVideoField(rows, campo) {
  return rows.reduce((acc, r) => {
    const arr = r[campo];
    if (arr && arr[0] && arr[0].value) return acc + parseInt(arr[0].value, 10);
    return acc;
  }, 0);
}

function montarFase1(rows) {
  if (!rows.length) return null;

  const investimento = somaCampo(rows, "spend");
  const impressoes = somaCampo(rows, "impressions");
  const cliques = somaCampo(rows, "inline_link_clicks");
  const cpm = impressoes > 0 ? investimento / (impressoes / 1000) : 0;
  const ctr = impressoes > 0 ? (cliques / impressoes) * 100 : 0;

  // NOTA IMPORTANTE: "Seguidores" aqui ainda usa o mesmo tipo de dado do
  // Gerenciador de Anúncios (não é o ideal, conforme combinado). No futuro,
  // isso será substituído por um número vindo direto do perfil da Thaís via
  // Instagram Graph API, separando seguidores orgânicos de seguidores pagos.
  const seguidores = valorDeAction(rows, ["follow", "onsite_conversion.follow", "like"]);
  const custoPorSeguidor = seguidores > 0 ? investimento / seguidores : null;

  return {
    investimento,
    impressoes,
    cliques,
    cpm,
    ctr,
    seguidores: seguidores > 0 ? seguidores : null,
    custoPorSeguidor,
  };
}

function montarFase2(rows) {
  if (!rows.length) return null;

  const investimento = somaCampo(rows, "spend");
  const impressoes = somaCampo(rows, "impressions");
  const cpm = impressoes > 0 ? investimento / (impressoes / 1000) : 0;

  const views3s = valorDeAction(rows, ["video_view"]);
  const views25 = valorDeVideoField(rows, "video_p25_watched_actions");
  const views50 = valorDeVideoField(rows, "video_p50_watched_actions");
  const views75 = valorDeVideoField(rows, "video_p75_watched_actions");
  const views95 = valorDeVideoField(rows, "video_p95_watched_actions");
  const cpv95 = views95 > 0 ? investimento / views95 : 0;

  const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);

  return {
    investimento,
    impressoes,
    cpm,
    views3s,
    views25,
    views50,
    views75,
    views95,
    cpv95,
    str: pct(views3s, impressoes),
    retHook: pct(views25, views3s),
    retStory1: pct(views50, views25),
    retStory2: pct(views75, views50),
    retOffer: pct(views95, views75),
  };
}

function montarFase3(rows) {
  if (!rows.length) return null;

  const investimento = somaCampo(rows, "spend");
  const impressoes = somaCampo(rows, "impressions");
  const alcance = somaCampo(rows, "reach");
  const cpm = impressoes > 0 ? investimento / (impressoes / 1000) : 0;

  const conversas = valorDeAction(rows, ["onsite_conversion.messaging_conversation_started_7d"]);
  const custoPorConversa = conversas > 0 ? investimento / conversas : 0;

  return {
    investimento,
    impressoes,
    alcance,
    cpm,
    conversas,
    custoPorConversa,
  };
}

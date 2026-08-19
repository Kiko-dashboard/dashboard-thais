// Esta função roda no servidor do Netlify (nunca no navegador do cliente),
// então o token de acesso fica protegido e nunca aparece pra quem visualiza o dashboard.

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
    // 1. Busca as campanhas ativas e seus objetivos
    const campaignsUrl = `https://graph.facebook.com/${API_VERSION}/${AD_ACCOUNT_ID}/campaigns?fields=id,name,objective,status&access_token=${ACCESS_TOKEN}`;
    const campaignsRes = await fetch(campaignsUrl);
    const campaignsData = await campaignsRes.json();

    if (campaignsData.error) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: campaignsData.error.message }),
      };
    }

    const campaigns = campaignsData.data || [];
    const objectiveByCampaignId = {};
    campaigns.forEach((c) => {
      objectiveByCampaignId[c.id] = classifyObjective(c.objective);
    });

    // 2. Busca os resultados (insights) por campanha nos últimos 7 dias
    const insightsUrl = `https://graph.facebook.com/${API_VERSION}/${AD_ACCOUNT_ID}/insights?level=campaign&date_preset=last_7d&fields=campaign_id,spend,reach,inline_link_clicks,actions,action_values&access_token=${ACCESS_TOKEN}`;
    const insightsRes = await fetch(insightsUrl);
    const insightsData = await insightsRes.json();

    if (insightsData.error) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: insightsData.error.message }),
      };
    }

    const rows = insightsData.data || [];

    // 3. Agrega os números por grupo de objetivo (leads, vendas, engajamento, trafego)
    const grupos = {
      todas: criarGrupoVazio(),
      leads: criarGrupoVazio(),
      vendas: criarGrupoVazio(),
      engajamento: criarGrupoVazio(),
      trafego: criarGrupoVazio(),
    };

    rows.forEach((row) => {
      const grupo = objectiveByCampaignId[row.campaign_id] || "outros";
      const spend = parseFloat(row.spend || 0);
      const reach = parseInt(row.reach || 0, 10);
      const clicks = parseInt(row.inline_link_clicks || 0, 10);
      const actions = row.actions || [];
      const actionValues = row.action_values || [];

      somarNoGrupo(grupos.todas, spend, reach, clicks, actions, actionValues, "todas");
      if (grupos[grupo]) {
        somarNoGrupo(grupos[grupo], spend, reach, clicks, actions, actionValues, grupo);
      }
    });

    const resultado = {};
    Object.keys(grupos).forEach((key) => {
      resultado[key] = finalizarGrupo(grupos[key], key);
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        atualizado_em: new Date().toISOString(),
        dados: resultado,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// Classifica o objetivo "cru" da Meta (que vem em inglês e formatos variados)
// em um dos 4 grupos que usamos no dashboard.
function classifyObjective(objective) {
  if (!objective) return "outros";
  const o = objective.toUpperCase();
  if (o.includes("LEAD")) return "leads";
  if (o.includes("SALES") || o.includes("CONVERSION")) return "vendas";
  if (o.includes("ENGAGEMENT")) return "engajamento";
  if (o.includes("TRAFFIC") || o.includes("LINK_CLICKS")) return "trafego";
  return "outros";
}

function criarGrupoVazio() {
  return { spend: 0, reach: 0, clicks: 0, resultado: 0, valorConversao: 0 };
}

function somarNoGrupo(grupo, spend, reach, clicks, actions, actionValues, tipoGrupo) {
  grupo.spend += spend;
  grupo.reach += reach;
  grupo.clicks += clicks;

  // Escolhe qual "ação" da Meta representa o resultado, dependendo do grupo
  const mapaAcao = {
    leads: ["lead", "onsite_conversion.lead_grouped"],
    vendas: ["purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"],
    engajamento: ["post_engagement"],
    trafego: ["link_click"],
    todas: ["lead", "onsite_conversion.lead_grouped", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase", "post_engagement"],
  };
  const tiposAceitos = mapaAcao[tipoGrupo] || [];

  actions.forEach((a) => {
    if (tiposAceitos.includes(a.action_type)) {
      grupo.resultado += parseInt(a.value || 0, 10);
    }
  });

  actionValues.forEach((a) => {
    if (a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase") {
      grupo.valorConversao += parseFloat(a.value || 0);
    }
  });
}

function finalizarGrupo(grupo, tipoGrupo) {
  const custoPorResultado = grupo.resultado > 0 ? grupo.spend / grupo.resultado : 0;
  const roas = grupo.spend > 0 ? grupo.valorConversao / grupo.spend : 0;

  const labels = {
    todas: "Resultados",
    leads: "Cadastros",
    vendas: "Compras",
    engajamento: "Interações",
    trafego: "Cliques no link",
  };
  const custoLabels = {
    todas: "Custo por resultado",
    leads: "Custo por cadastro",
    vendas: "Custo por venda",
    engajamento: "Custo por interação",
    trafego: "Custo por clique",
  };

  return {
    gasto: grupo.spend,
    alcance: grupo.reach,
    cliques: grupo.clicks,
    resultLabel: labels[tipoGrupo],
    resultado: tipoGrupo === "trafego" ? grupo.clicks : grupo.resultado,
    custoLabel: custoLabels[tipoGrupo],
    custoPorResultado: custoPorResultado,
    roas: tipoGrupo === "vendas" || tipoGrupo === "todas" ? roas : null,
  };
}

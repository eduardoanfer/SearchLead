# Prospector

Painel web (login + senha) para prospecção B2B: busca empresas por nicho e região
na Google Places API, verifica quais têm WhatsApp e dispara campanhas pela Evolution API.

## Instalação
    npm install
    cp .env.example .env     # preencha os valores
    npm start                # http://localhost:3000

## Configuração necessária
1. **Google Places API (New)**: crie uma chave no Google Cloud e ative a API.
   O campo de telefone é cobrado em faixa superior; confira os preços e defina um limite de gasto.
2. **Evolution API v2**: instância já conectada ao WhatsApp. Preencha URL, apikey e nome da instância.
3. **Descadastro automático**: na Evolution, configure o webhook da instância para
   `https://SEU-DOMINIO/webhook/evolution?token=SEU_WEBHOOK_TOKEN` com o evento `MESSAGES_UPSERT`.
   Quem responder SAIR / PARAR / STOP é bloqueado automaticamente.

## Fluxo
1. Buscar empresas (nicho + cidade) → 2. Verificar WhatsApp → 3. Criar campanha → 4. Iniciar.

## Boas práticas para não perder o número
- Comece com 20 a 30 envios por dia e suba aos poucos ao longo de semanas.
- Use um chip dedicado e aquecido, não o número principal da empresa.
- Escreva uma primeira mensagem curta, que pergunte algo, sem links nem anexos.
- Varie o texto com {Olá|Oi} e use {primeiro_nome}.
- Pare a campanha se aumentar o número de bloqueios ou respostas negativas.
- Em produção, coloque atrás de HTTPS (Nginx, Caddy ou Cloudflare).

## Observações legais
Dados de empresas divulgados publicamente têm base mais segura na LGPD (legítimo interesse),
mas MEIs e empresários individuais podem ter número pessoal. Mantenha o aviso de descadastro,
respeite todo pedido de saída e registre a origem dos contatos. Disparo em massa também vai contra
os termos do WhatsApp, então existe risco de banimento mesmo com boas práticas.

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { MessageKey } from "./en";

// The Record<MessageKey, string> type guarantees pt-BR stays complete: a missing key fails to
// compile.
export const ptBR: Record<MessageKey, string> = {
  "app.name": "Schrodump",
  "app.tagline": "Backups lógicos de banco, verificados",

  "nav.dashboard": "Painel",
  "nav.targets": "Alvos",
  "nav.destinations": "Destinos",
  "nav.policies": "Políticas",
  "nav.jobs": "Jobs",
  "nav.artifacts": "Artefatos",
  "nav.settings": "Configurações",
  "nav.signOut": "Sair",

  "common.save": "Salvar",
  "common.cancel": "Cancelar",
  "common.create": "Criar",
  "common.close": "Fechar",
  "common.retry": "Tentar de novo",
  "common.loading": "Carregando…",
  "common.error": "Algo deu errado",
  "common.errorDetail": "A requisição falhou: {message}",
  "common.empty": "Nada por aqui ainda",
  "common.required": "Campo obrigatório",
  "common.configured": "Configurado",
  "common.replace": "Substituir",
  "common.notAvailable": "Indisponível ainda",
  "common.endpointPending": "Estes dados dependem de um endpoint do servidor ainda não disponível.",

  "locale.label": "Idioma",
  "locale.en": "Inglês",
  "locale.pt-BR": "Português (Brasil)",

  "state.verified": "Verificado",
  "state.unobserved": "Não observado",
  "state.failed": "Falhou",
  "state.unobserved.hint": "Nenhum verify rodou — este backup é uma pergunta em aberto.",

  "auth.login.title": "Entrar",
  "auth.login.email": "Email",
  "auth.login.password": "Senha",
  "auth.login.submit": "Entrar",
  "auth.login.error": "Email ou senha inválidos",

  "setup.title": "Criar o primeiro administrador",
  "setup.description": "Este link é de uso único e expira. Defina a conta admin inicial.",
  "setup.token": "Token de setup",
  "setup.email": "Email",
  "setup.password": "Senha",
  "setup.submit": "Criar admin",
  "setup.done.title": "Administrador criado",
  "setup.done.description": "Agora você pode entrar.",
  "setup.done.goToLogin": "Ir para o login",
  "setup.closed.title": "Setup encerrado",
  "setup.closed.description": "Já existe um administrador. A recuperação é feita via CLI.",
};

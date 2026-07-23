# Architecture decisions

Decisões já tomadas para o v1, com a justificativa de cada uma. Este documento registra
o *porquê*; detalhes de implementação vivem no código e nos `CLAUDE.md` de cada pacote.

## 1. Backup lógico no v1

Só backup **lógico** (dumps via clients nativos) no v1. Backup físico será delegado a
ferramentas externas por um agent futuro, **não reimplementado**.
— Reimplementar backup físico duplica ferramentas maduras e específicas de cada engine
sem ganho para o diferencial do produto (verificação de restore).

## 2. Agentless

Acesso ao banco alvo por **conexão de rede**, sem instalar agente no host do banco.
— Reduz atrito de adoção e superfície operacional; não exige acesso privilegiado ao host
alheio, apenas credencial e rota de rede.

## 3. Docker-first com executores efêmeros

Execução **Docker-first**: cada dump/restore roda num executor efêmero com o client da
versão certa. A imagem do server **não** carrega clients de banco.
— Isola versões de client conflitantes e mantém a imagem do server pequena, auditável e
sem binários de terceiros com CVEs próprios.

## 4. Destino S3-compatible apenas

O único destino de armazenamento é **S3-compatible**. O staging local é transitório e
**sempre apagado** após o uso.
— Um único contrato de armazenamento simplifica o código e a operação; staging efêmero
evita acúmulo de dados sensíveis em disco local.

## 5. Estado de backup ternário

O estado de um backup é ternário: `VERIFIED` / `UNOBSERVED` / `FAILED`. **Não existe
"OK".**
— Um backup cujo restore nunca foi observado não é confiável; forçar `UNOBSERVED` em vez
de "OK" impede a falsa sensação de segurança que é o problema central da categoria.

## 6. `organizationId` desde o início

`organizationId` está presente em **todo** o modelo de dados desde o começo, mesmo em
deploy single-tenant.
— Retrofit de multi-tenancy num modelo já em produção é caro e arriscado; carregar a
coluna desde o dia zero é barato e evita migração destrutiva depois.

## 7. Retenção é responsabilidade da aplicação

A retenção é aplicada **pela aplicação**. Configurar lifecycle no bucket é **proibido** e
está documentado como tal.
— A aplicação é a única que sabe se um backup foi `VERIFIED`; lifecycle no bucket poderia
apagar o único backup bom por idade, sem consultar o estado de verificação.

## 8. Criptografia client-side com múltiplos recipients

Criptografia **client-side** com múltiplos recipients (operacional + escrow); o `keyId` é
gravado no manifesto para permitir rotação.
— Cifrar antes de sair do executor mantém o destino zero-knowledge; múltiplos recipients
evitam ponto único de perda de chave, e o `keyId` no manifesto torna a rotação possível
sem reprocessar backups antigos.

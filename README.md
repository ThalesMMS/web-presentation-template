# Presentation Template

Esqueleto reutilizável de apresentação HTML com três superfícies sincronizadas em tempo real:

- **Telão:** slides, resultados ao vivo e QR code.
- **Plateia:** votação pelo celular e envio de perguntas.
- **Régie:** abertura, fechamento e reset de enquetes, além da moderação das perguntas.

O estado da sala fica em um Durable Object do Cloudflare Workers e é distribuído por WebSocket.

## Começar

Requisitos: Node.js 20 ou mais recente e uma conta Cloudflare.

```bash
npm install
npm run dev
```

No ambiente local, abra:

- Telão: `http://localhost:8787/?k=change-this-key`
- Plateia: `http://localhost:8787/participar/`
- Régie: `http://localhost:8787/regie/?k=change-this-key`

Ao validar a chave, o servidor cria uma sessão privada e remove a chave da URL. Os links do telão e da régie não ficam disponíveis sem essa sessão.

## Personalizar

Edite [public/presentation.config.js](public/presentation.config.js). Esse arquivo concentra:

- título, subtítulo e identificação do apresentador;
- cores da marca;
- enquetes de escolha única ou múltipla;
- ordem e conteúdo dos slides.

Tipos de slide incluídos:

| Tipo | Uso |
| --- | --- |
| `cover` | Abertura com QR code e total de participantes |
| `statement` | Ideia central com título e descrição |
| `list` | Lista de pontos |
| `poll` | Resultado de uma enquete em tempo real |
| `quote` | Citação ou mensagem principal |
| `closing` | Encerramento e chamada para ação |

Para associar um slide a uma enquete, use a mesma chave declarada em `polls`:

```js
{
  type: 'poll',
  poll: 'warmup',
  eyebrow: 'Enquete ao vivo'
}
```

O endereço codificado no QR code é calculado a partir do domínio atual. Não é necessário alterar o HTML ao publicar em outro endereço.

## Enquetes

Escolha única:

```js
example: {
  question: 'Qual opção representa melhor sua situação?',
  type: 'single',
  options: [
    { id: 'a', label: 'Opção A' },
    { id: 'b', label: 'Opção B' }
  ]
}
```

Escolha múltipla:

```js
example: {
  question: 'Quais opções se aplicam?',
  type: 'multiple',
  exclusive: 'none',
  options: [
    { id: 'a', label: 'Opção A' },
    { id: 'b', label: 'Opção B' },
    { id: 'none', label: 'Nenhuma delas' }
  ]
}
```

Quando `exclusive` é definido, selecionar essa opção limpa as demais; selecionar outra opção limpa a exclusiva.

## Controles do telão

- `←` / `→` ou Page Up / Page Down: navegar.
- Home / End: primeiro ou último slide.
- Espaço: avançar.
- `F`: alternar tela cheia.
- Botões no canto inferior: navegação e tela cheia por mouse ou toque.

Ao entrar em um slide de enquete, ela é aberta automaticamente. A régie continua permitindo abrir, fechar ou zerar cada enquete manualmente.

## Publicar

Troque em `wrangler.jsonc`:

- `name`: nome público do Worker;
- `PRESENTER_KEY`: chave usada para liberar telão e régie.

Em produção, prefira armazenar a chave como secret:

```bash
npx wrangler secret put PRESENTER_KEY
npm run deploy
```

Se usar um secret, remova `PRESENTER_KEY` da seção `vars` antes da publicação.

## Testar

```bash
npm test
```

Os testes verificam a integridade da configuração, as referências entre slides e enquetes e o cálculo dos resultados.

## Estrutura

```text
presentation-template/
├─ public/
│  ├─ index.html                 telão
│  ├─ participar/index.html      plateia
│  ├─ regie/index.html           painel de controle
│  ├─ presentation.config.js     conteúdo editável
│  └─ assets/                    estilos, sincronização e QR code
├─ src/worker.js                 sala em tempo real e autenticação
├─ tests/                        testes de configuração e resultados
├─ wrangler.jsonc                configuração do Cloudflare
└─ package.json
```

## Licença de terceiro

O gerador de QR code incluído em `public/assets/qrcode.js` usa licença MIT. Consulte [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

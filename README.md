# telar

Espelhamento de tela pelo navegador. Você roda um script, ele te devolve um link
`https://…trycloudflare.com`, você manda o link no chat e as pessoas veem sua tela.

Sem cadastro, sem instalar nada, sem dependência de npm.

---

## Como usar

**Windows** — duplo clique em `start.bat` (ou `.\start.bat` no terminal).

**Linux / macOS**

```sh
chmod +x start.sh    # só na primeira vez
./start.sh
```

**A primeira execução se vira sozinha.** Ela baixa para `bin/` o que faltar:

- o `cloudflared` (~40 MB), sempre;
- o **Node.js portátil** (~30 MB), só se você não tiver Node 16+ instalado.

Nada vai para o sistema, nada pede sudo nem admin, e apagar a pasta `bin/`
desfaz tudo. Da segunda execução em diante sobe na hora.

O terminal mostra:

```
  MANDE ESTE LINK PARA QUEM VAI ASSISTIR:

      https://palavras-aleatorias.trycloudflare.com

  Seu painel (só nesta máquina):
      http://localhost:8787/b?k=a1b2c3d4e5
```

O painel abre sozinho no navegador. Clique em **Compartilhar tela**, escolha a tela,
a janela ou a aba, e pronto — quem tiver o link já está vendo.

Para levar o **áudio** junto, marque *compartilhar áudio do sistema* / *da aba* na
janelinha de seleção do navegador. Isso só existe no Chrome e no Edge; o Firefox
compartilha vídeo mas não áudio de tela.

`Ctrl+C` encerra tudo — servidor e túnel.

---

## Os dois modos de entrega

| | WebRTC (padrão) | Compatível (relay) |
|---|---|---|
| Atraso | ~0,2 s | ~1 s |
| Caminho | direto entre as máquinas | tudo pelo túnel HTTPS |
| Passa em rede corporativa | às vezes | praticamente sempre |
| Safari / iPhone | funciona | não funciona |

Começa em WebRTC porque é melhor. Se alguém não conseguir conectar, o painel
percebe e **troca sozinho** para o modo compatível — dá para desligar isso na
caixinha do painel, ou trocar na mão pelo seletor **Entrega**.

Se a rede for muito fechada e nem um nem outro passar, veja *TURN* abaixo.

---

## Qualidade

Três presets prontos, e embaixo deles **resolução, fps e taxa soltos** para você
escolher na mão. Mexer em qualquer um dos três joga o preset para *Personalizado*.
Tudo vale na hora, sem precisar parar a transmissão.

| | Opções |
|---|---|
| Resolução | Original, 2160p, 1440p, 1080p, 900p, 720p, 540p, 360p |
| FPS | 5, 8, 10, 12, 15, 20, 24, 30, 60 |
| Taxa | 0,4 a 12 Mb/s |

Presets: **Leve** 720p·10fps·0,8M · **Normal** 1080p·15fps·2M · **Nítido** 1440p·24fps·4M.

Conta a sua **banda de subida**, multiplicada pelo número de pessoas assistindo
(nos dois modos). Cinco pessoas em Normal = ~10 Mb/s subindo. Se travar, desça a
taxa antes de mexer na resolução — costuma resolver com menos perda visível.

Tem também um seletor entre **nitidez** (código, texto, planilha — segura a
resolução e derruba o fps quando aperta) e **fluidez** (vídeo, jogo — faz o contrário).

### Prévia

A prévia da sua própria tela vem **desligada**, de propósito: fazer o navegador
decodificar e desenhar de volta o que ele acabou de capturar gasta CPU à toa e é
uma das causas mais comuns de travamento durante a transmissão. Se quiser conferir
o enquadramento, ligue a caixinha *Mostrar prévia*, olhe, e desligue de novo —
com ela desligada o `srcObject` do vídeo é realmente solto, não só escondido.

Enquanto ela está desligada, os números do painel (assistindo, tempo no ar, envio,
resolução) continuam dizendo se está tudo certo.

---

## Opções

```sh
./start.sh --port 9000      # outra porta
./start.sh --pin 4821       # exige ?p=4821 no link para assistir
./start.sh --no-tunnel      # só rede local, sem Cloudflare
./start.sh --no-open        # não abre o navegador sozinho
```

Variáveis de ambiente:

| Variável | Para quê |
|---|---|
| `TELAR_PORT` | porta (mesmo que `--port`) |
| `TELAR_KEY` | fixa a chave do painel em vez de sortear |
| `TELAR_PIN` | mesmo que `--pin` |
| `TELAR_MAX_VIEWERS` | teto de espectadores (padrão 50) |
| `TELAR_CF_PROTOCOL` | `http2` ou `quic`, força o transporte do cloudflared |
| `TELAR_TURN_URL` | servidor TURN, ex. `turn:host:3478` |
| `TELAR_TURN_USER` / `TELAR_TURN_PASS` | credenciais do TURN |

### TURN

O WebRTC usa STUN público do Google, que resolve a maioria dos casos. Em rede
corporativa fechada dos dois lados, nem STUN salva — aí ou você usa o modo
compatível (que sempre funciona, porque é HTTPS pelo túnel) ou aponta um TURN:

```sh
TELAR_TURN_URL=turn:seu.host:3478 TELAR_TURN_USER=user TELAR_TURN_PASS=senha ./start.sh
```

---

## Quem está assistindo, e como tirar alguém

Antes de entrar, a pessoa digita um **apelido**. Ele aparece no seu painel junto
com o IP e há quanto tempo ela está lá:

```
Thomas                    [ Expulsar ] [ Banir IP ]
189.45.x.x · 12min
```

- **Expulsar** derruba a conexão na hora. A pessoa pode voltar se quiser — serve
  para quem entrou por engano ou travou.
- **Banir IP** derruba todo mundo naquele endereço e passa a recusar o IP tanto
  no WebSocket quanto no HTTP: quem for banido nem carrega mais a página. Os IPs
  banidos ficam listados abaixo, com botão de **Desbanir**.

O ban vale só enquanto o programa está rodando — fechou, zerou.

Um cuidado real: **em rede corporativa ou celular, muita gente sai pelo mesmo IP**.
Banir um IP pode derrubar colegas junto. Para tirar uma pessoa só, use Expulsar.

Os espectadores veem quantos e quais nomes estão assistindo, mas **nunca recebem
o IP de ninguém** — isso só vai para o seu painel.

---

## Segurança

O link do `trycloudflare` é aleatório e não é indexado, mas **é público: quem tiver
o endereço, assiste**. Ele muda a cada execução.

O que já vem ligado:

| Proteção | Como funciona |
|---|---|
| Painel protegido | Chave sorteada a cada execução, comparada em tempo constante. Ela não sai no link público — quem só tem o link não transmite no seu lugar. |
| Anti-força-bruta | 8 chutes errados na chave ou no PIN e o IP fica bloqueado por 10 min, mesmo que depois acerte. |
| Rate limit por IP | 300 requisições HTTP/min, 30 aberturas de WebSocket/min e no máximo 6 abas simultâneas por endereço. |
| Teto de sala | 50 espectadores (`TELAR_MAX_VIEWERS` muda). |
| Apelido saneado | Cortado em 24 caracteres, sem caracteres de controle nem invisíveis — incluindo os de inversão RTL, que dão para forjar nomes. É sempre inserido como texto, nunca como HTML. |
| IP real e não forjável | Atrás do túnel tudo chega de `127.0.0.1`; o IP verdadeiro vem no cabeçalho `CF-Connecting-IP`. O servidor só acredita nesse cabeçalho quando a conexão veio de fato do `cloudflared` local — assim ninguém na sua rede forja o próprio IP para escapar de ban ou de rate limit. |

Ainda vale fazer da sua parte:

- `--pin 1234` acrescenta um código ao link; sem ele o espectador é recusado.
- Compartilhe **uma janela ou aba**, não a tela inteira, se houver qualquer coisa
  sensível aberta.

---

## Se der problema

**"Nada sendo transmitido" para sempre no espectador** — o painel só entra no ar
depois que você clica em *Compartilhar tela*.

**Erro 1033 da Cloudflare ao abrir o link** — normal nos primeiros segundos. O
`cloudflared` cria e registra o túnel em ~1 s, mas o endereço leva mais um tempo
para responder no mundo todo, e não dá para acelerar isso. Por isso o launcher
imprime o link e, quando ele começa a responder de verdade, mostra:

```
  ✓ link confirmado — pode mandar
```

Espere essa linha antes de mandar o link. Se passar de ~4 min sem confirmar, o
launcher avisa; aí `Ctrl+C` e rodar de novo pega outro endereço.

**Túnel não sobe** — a rede pode estar bloqueando UDP/QUIC. O launcher já tenta
`http2` na segunda tentativa; para forçar direto:
`TELAR_CF_PROTOCOL=http2 ./start.sh`. Se ainda assim não subir, ele segue no ar
na rede local e mostra o endereço `http://SEU_IP:8787/`. O que o `cloudflared`
falou fica em `tunnel.log`.

**O túnel caiu no meio** — o launcher reabre sozinho. O endereço muda, então ele
imprime o banner novo; reenvie o link.

**Alguém vê tela preta no modo compatível** — quem entra no meio espera o próximo
keyframe. O transmissor força um assim que alguém entra, então deve resolver em
até ~2,5 s. Se não resolver, mande a pessoa recarregar.

**Botão de compartilhar desabilitado** — `getDisplayMedia` exige contexto seguro.
O painel roda em `http://localhost`, que conta como seguro. Se você abriu o painel
pelo IP da rede (`http://192.168.x.x`), o navegador bloqueia — use `localhost`.

**Safari / iPhone assistindo** — só funciona em WebRTC; o modo compatível usa WebM,
que o Safari não reproduz via MSE.

---

## Como funciona

```
                    ┌─ WebRTC: vídeo direto ─────────────┐
                    │  (sinalização passa pelo servidor) │
                    ▼                                    ▼
[ sua tela ] → [ painel ] → [ server.js ] ← túnel ← [ espectador ]
                              ↑         └─ relay: vídeo pelo WebSocket ─┘
                         Node puro, 0 deps
```

| Arquivo | O que faz |
|---|---|
| `run.js` | acha porta livre, baixa cloudflared, sobe servidor + túnel, imprime o link |
| `server.js` | HTTP estático + hub WebSocket (implementado na mão, sem `ws`) |
| `public/broadcast.html` | painel: captura, presets, WebRTC por espectador, gravador do relay |
| `public/watch.html` | espectador: apelido na entrada, WebRTC ou MediaSource, cola na ponta ao vivo |
| `tunnel.log` | saída crua do cloudflared, para quando o túnel der problema |

No modo relay o servidor guarda o primeiro chunk do `MediaRecorder` (o cabeçalho
WebM) e reenvia para cada pessoa que chega, senão o player não tem como começar
a decodificar no meio do stream.

# telar

Espelhamento de tela pelo navegador. Você roda um script, ele te devolve um link
`https://…trycloudflare.com`, você manda o link no chat e as pessoas veem sua tela.

Sem cadastro, sem instalar nada além do Node, sem dependência de npm.

---

## Como usar

**Windows** — duplo clique em `start.bat` (ou `.\start.bat` no terminal).

**Linux / macOS**

```sh
chmod +x start.sh    # só na primeira vez
./start.sh
```

Na primeira execução ele baixa o `cloudflared` (~40 MB) para `bin/`. Depois disso sobe na hora.

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

| Preset | Resolução | Taxa | Banda |
|---|---|---|---|
| Leve | 720p | 10 fps | ~0,7 Mbps |
| Normal | 1080p | 15 fps | ~1,8 Mbps |
| Nítido | 1440p | 24 fps | ~4 Mbps |

Conta a sua **banda de subida**, multiplicada pelo número de pessoas assistindo
(em ambos os modos). Cinco pessoas no preset Normal = ~9 Mbps subindo. Se travar,
caia para Leve.

Tem também um seletor entre **nitidez** (código, texto, planilha — mantém a
resolução e derruba o fps quando aperta) e **fluidez** (vídeo, jogo — faz o contrário).

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

## Segurança

O link do `trycloudflare` é aleatório e não é indexado, mas **é público: quem tiver
o endereço, assiste**. Ele muda a cada execução.

- `--pin 1234` acrescenta um código; sem ele o WebSocket do espectador é recusado.
- O painel do transmissor é protegido por uma chave sorteada a cada execução, e ela
  não sai no link público — ninguém que só tenha o link consegue transmitir no seu lugar.
- Compartilhe **uma janela ou aba**, não a tela inteira, se houver qualquer coisa
  sensível aberta.

---

## Se der problema

**"Nada sendo transmitido" para sempre no espectador** — o painel só entra no ar
depois que você clica em *Compartilhar tela*.

**Túnel não sobe** — a rede pode estar bloqueando UDP/QUIC. O launcher já tenta
`http2` na segunda tentativa; para forçar direto:
`TELAR_CF_PROTOCOL=http2 ./start.sh`. Se ainda assim não subir, ele segue no ar
na rede local e mostra o endereço `http://SEU_IP:8787/`.

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
| `public/watch.html` | espectador: WebRTC ou MediaSource, cola na ponta ao vivo |

No modo relay o servidor guarda o primeiro chunk do `MediaRecorder` (o cabeçalho
WebM) e reenvia para cada pessoa que chega, senão o player não tem como começar
a decodificar no meio do stream.

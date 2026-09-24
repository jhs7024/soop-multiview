// SOOP 플레이어 / 채팅 주소와 신호 (mul.live · Mul.Live Plus 와 같은 방식)
// SOOP 쪽이 바뀌어서 영상이나 채팅이 안 나오면 이 파일만 고치면 된다.

const SOOP = {
  PLAYER_ORIGIN: 'https://play.sooplive.com',
  playerUrl: (id) => `https://play.sooplive.com/${encodeURIComponent(id)}/direct?fromApi=1`,
  chatUrl: (id) => `https://play.sooplive.com/${encodeURIComponent(id)}?vtype=chat`,
  // 플레이어 iframe 이름. 채팅 화면이 이 이름으로 자기 방송 플레이어를 찾는다 (확장 프로그램의 soop-frame.js)
  frameName: (id) => (isNaN(Number(id)) ? id : `#${id}`),
  // 플레이어가 "준비됨(PonReady)" 을 보내면 이 "재생할 방송(Pload)" 으로 답해야 재생된다
  ploadMessage: (id) => ({
    cmd: 'Pload',
    id: SOOP.frameName(id),
    mutePlay: false,
    showChat: true,
    autoPlay: true,
    isAdShow: true,
    showQualityBox: true,
    fromApi: '1',
  }),
};

// 확장 프로그램과 대화하기 (확장 프로그램의 bridge.js 가 받아서 처리)
// 즐겨찾기 불러오기, 로그인 연결 같은 일은 웹페이지가 직접 못 해서 확장 프로그램에 부탁한다.
const hasExtension = () => document.documentElement.dataset.smvExtension === '1';

function askExtension(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!hasExtension()) {
      reject(new Error('no-extension'));
      return;
    }
    const reqId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('timeout'));
    }, 30000);
    function onMessage(e) {
      if (e.source !== window || e.data?.smv !== 'response' || e.data.reqId !== reqId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(e.data.res);
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ smv: 'request', reqId, type, payload }, location.origin);
  });
}

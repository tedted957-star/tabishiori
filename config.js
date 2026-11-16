// ↓↓↓ この「const firebaseConfig = { … };」の部分を、Firebaseに表示されたものと丸ごと置き換えてください ↓↓↓
const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
// ↑↑↑ ここまで ↑↑↑

// Googleマップのキー（なくてもOK。入れると宿の写真・Googleの地図・正確な車ルートになります）
const mapsApiKey = "";

window.APP_CONFIG = { firebase: firebaseConfig, mapsApiKey: mapsApiKey };

// prompts.js — daily diary prompts, N3-appropriate. PURE.
import { daysBetween } from './util.js';

export const PROMPTS = [
  { ja: '今日一番楽しかったことは何ですか。', en: 'What was the most fun thing today?' },
  { ja: '今朝、起きてから家を出るまで何をしましたか。', en: 'What did you do this morning between waking up and leaving home?' },
  { ja: '最近食べた一番おいしいものについて話してください。', en: 'Talk about the most delicious thing you ate recently.' },
  { ja: '子どもの頃、よく遊んだ場所はどこですか。', en: 'Where did you often play as a child?' },
  { ja: '今週の予定を教えてください。', en: 'Tell me about your plans for this week.' },
  { ja: '最近、困ったことはありましたか。どうしましたか。', en: 'Did anything trouble you recently? What did you do?' },
  { ja: '好きな季節とその理由を話してください。', en: 'Talk about your favourite season and why.' },
  { ja: '今日の天気と、それで気分がどう変わったか話してください。', en: "Describe today's weather and how it affected your mood." },
  { ja: 'もし一週間休みがあったら、何をしたいですか。', en: 'If you had a week off, what would you want to do?' },
  { ja: '最近見た映画やドラマについて話してください。', en: 'Talk about a film or TV show you watched recently.' },
  { ja: '日本語を勉強し始めたきっかけは何ですか。', en: 'What made you start studying Japanese?' },
  { ja: '今日、誰と話しましたか。何について話しましたか。', en: 'Who did you talk to today, and about what?' },
  { ja: '家の近くにあるお気に入りの店を紹介してください。', en: 'Introduce a favourite shop near your home.' },
  { ja: '最近買ってよかったものは何ですか。', en: "What's something you bought recently that you're glad you got?" },
  { ja: '朝型ですか、夜型ですか。どうしてですか。', en: 'Are you a morning person or a night owl? Why?' },
  { ja: '今までで一番思い出に残っている旅行について話してください。', en: 'Talk about your most memorable trip so far.' },
  { ja: '週末はたいてい何をして過ごしますか。', en: 'How do you usually spend your weekends?' },
  { ja: '最近がんばっていることは何ですか。', en: 'What have you been working hard on lately?' },
  { ja: '小さいころの夢は何でしたか。今はどうですか。', en: 'What was your childhood dream? How about now?' },
  { ja: '今日の晩ご飯について話してください。', en: "Talk about today's dinner." },
  { ja: 'ストレスがたまったとき、どうしますか。', en: 'What do you do when you get stressed?' },
  { ja: '尊敬している人について話してください。', en: 'Talk about someone you respect.' },
  { ja: '最近、新しく知ったことは何ですか。', en: "What's something new you learned recently?" },
  { ja: '住んでいる町のいいところと悪いところを話してください。', en: 'Talk about the good and bad points of your town.' },
  { ja: '一番よく使うアプリは何ですか。どう使っていますか。', en: 'Which app do you use most, and how?' },
  { ja: '今日は何時間ぐらい寝ましたか。よく眠れましたか。', en: 'How many hours did you sleep? Did you sleep well?' },
  { ja: '友だちに勧めたい本や漫画はありますか。', en: 'Is there a book or manga you would recommend to a friend?' },
  { ja: '最近、笑ったことを話してください。', en: 'Tell me about something that made you laugh recently.' },
  { ja: '料理は得意ですか。よく作る料理は何ですか。', en: 'Are you good at cooking? What do you often make?' },
  { ja: '今日の仕事や勉強はどうでしたか。', en: 'How did work or study go today?' },
  { ja: '子どものころ、好きだった食べ物と嫌いだった食べ物は何ですか。', en: 'What foods did you like and dislike as a child?' },
  { ja: '日本で行ってみたい場所はどこですか。どうしてですか。', en: 'Where in Japan would you like to go, and why?' },
  { ja: '最近、運動していますか。どんな運動ですか。', en: 'Have you been exercising lately? What kind?' },
  { ja: '雨の日は何をするのが好きですか。', en: 'What do you like to do on rainy days?' },
  { ja: 'あなたの家族について少し話してください。', en: 'Tell me a little about your family.' },
  { ja: '今、一番ほしいものは何ですか。', en: 'What do you want most right now?' },
  { ja: '最近、失敗したことはありますか。そこから何を学びましたか。', en: 'Have you made a mistake recently? What did you learn?' },
  { ja: '今日、見たものや聞いたもので印象に残ったことは何ですか。', en: 'What did you see or hear today that left an impression?' },
  { ja: 'よく聞く音楽について話してください。', en: 'Talk about the music you often listen to.' },
  { ja: '十年後、どんな生活をしていたいですか。', en: 'What kind of life do you want to be living in ten years?' },
  { ja: '最近、人に親切にしてもらったことはありますか。', en: 'Has someone been kind to you recently?' },
  { ja: '休みの日の理想的な一日を説明してください。', en: 'Describe your ideal day off.' },
  { ja: '通勤や通学はどうしていますか。何時間かかりますか。', en: 'How do you commute, and how long does it take?' },
  { ja: '今の部屋について説明してください。', en: 'Describe the room you are in now.' },
  { ja: 'ペットを飼うなら、何を飼いたいですか。', en: 'If you had a pet, what would you want?' },
  { ja: '最近、天気のせいで予定が変わったことはありますか。', en: 'Have your plans changed recently because of the weather?' },
  { ja: '日本語の勉強で、一番難しいと思うことは何ですか。', en: 'What do you find hardest about studying Japanese?' },
  { ja: '昨日の夜、何をしましたか。', en: 'What did you do last night?' },
  { ja: '好きなお祭りやイベントについて話してください。', en: 'Talk about a festival or event you like.' },
  { ja: 'もし宝くじが当たったら、どうしますか。', en: 'What would you do if you won the lottery?' },
  { ja: '最近、何か新しいことに挑戦しましたか。', en: 'Have you tried anything new recently?' },
  { ja: 'あなたの国と日本の違いを一つ説明してください。', en: 'Explain one difference between your country and Japan.' },
  { ja: '朝ご飯は毎日食べますか。今日は何を食べましたか。', en: 'Do you eat breakfast every day? What did you have today?' },
  { ja: '今日、うれしかったことは何ですか。', en: 'What made you happy today?' },
  { ja: '最近、少し残念だったことを話してください。', en: 'Talk about something slightly disappointing recently.' },
  { ja: '一人で過ごすのと、友だちと過ごすの、どちらが好きですか。', en: 'Do you prefer spending time alone or with friends?' },
  { ja: '最近の買い物について話してください。', en: 'Talk about some recent shopping.' },
  { ja: '好きな飲み物は何ですか。いつ飲みますか。', en: 'What is your favourite drink, and when do you drink it?' },
  { ja: '初めて日本語で話したときのことを覚えていますか。', en: 'Do you remember the first time you spoke Japanese?' },
  { ja: '今週、一番忙しかった日はいつでしたか。', en: 'Which day this week was the busiest?' },
  { ja: '自分の性格を三つの言葉で説明してください。', en: 'Describe your personality in three words, and explain.' },
  { ja: '最近、何かを我慢したことはありますか。', en: 'Have you held back from something recently?' },
  { ja: 'スマホがなかったら、生活はどう変わると思いますか。', en: 'How would your life change without a smartphone?' },
  { ja: '学生時代の思い出を一つ話してください。', en: 'Share one memory from your school days.' },
  { ja: '今日、道や駅で気づいたことはありますか。', en: 'Did you notice anything on the street or at the station today?' },
  { ja: '今、はまっていることは何ですか。', en: 'What are you hooked on at the moment?' },
  { ja: '体の調子はどうですか。最近、健康のために何かしていますか。', en: 'How are you feeling physically? Doing anything for your health?' },
  { ja: '誰かにお礼を言いたいことはありますか。', en: 'Is there someone you would like to thank?' },
  { ja: '好きな場所で一日過ごせるなら、どこに行きますか。', en: 'If you could spend a day anywhere, where would you go?' },
  { ja: '最近読んだニュースで気になったことを話してください。', en: 'Talk about a news story that caught your attention.' },
  { ja: 'あなたの町を観光客に紹介するとしたら、何を勧めますか。', en: 'What would you recommend to a tourist visiting your town?' },
  { ja: '今年の目標は何ですか。どのぐらい達成できましたか。', en: "What are this year's goals? How far have you got?" },
  { ja: '最近、早起きしたことはありますか。何のためでしたか。', en: 'Did you get up early recently? What for?' },
  { ja: '好きなレストランを紹介してください。', en: 'Introduce a restaurant you like.' },
  { ja: '子どものころの自分に何かアドバイスするなら、何と言いますか。', en: 'What advice would you give your childhood self?' },
  { ja: '最近、びっくりしたことはありますか。', en: 'Has anything surprised you recently?' },
  { ja: '今日の自分に点数をつけるなら、何点ですか。どうしてですか。', en: 'If you scored yourself today out of 100, what would it be and why?' },
  { ja: '明日やりたいことを三つ話してください。', en: 'Talk about three things you want to do tomorrow.' },
  { ja: '電車やバスの中で、普段何をしていますか。', en: 'What do you usually do on trains or buses?' },
  { ja: '最近、誰かとけんかしたり、意見が合わなかったりしましたか。', en: 'Did you recently argue or disagree with someone?' },
  { ja: '一番好きな日本語の言葉は何ですか。どうしてですか。', en: 'What is your favourite Japanese word, and why?' },
  { ja: '最近、写真を撮りましたか。何の写真ですか。', en: 'Did you take any photos recently? Of what?' },
  { ja: '寒い日（暑い日）を快適に過ごすコツを教えてください。', en: 'Share your tips for getting through cold (or hot) days.' },
  { ja: '今日、時間を無駄にしたと思うことはありますか。', en: 'Is there anything today you feel was a waste of time?' },
  { ja: '最近会った人について話してください。', en: 'Talk about someone you met recently.' },
  { ja: 'もし日本に住むなら、どの町に住みたいですか。', en: 'If you lived in Japan, which town would you choose?' },
  { ja: '家事の中で、好きなことと嫌いなことは何ですか。', en: 'Which household chores do you like and dislike?' },
  { ja: '今日の気分を天気にたとえると、どんな天気ですか。', en: 'If your mood today were weather, what would it be?' },
  { ja: '寝る前にいつもすることは何ですか。', en: 'What do you always do before going to bed?' },
  { ja: '最近、何か習慣を変えましたか。', en: 'Have you changed any habits recently?' },
  { ja: '一週間をふり返って、よかったことと反省したいことを話してください。', en: 'Looking back on the week, what went well and what would you do differently?' },
];

const STEP = 37; // coprime with PROMPTS.length so consecutive days jump around the list
const EPOCH = '2024-01-01';

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

/** Index of the prompt for a local date string 'YYYY-MM-DD'. Deterministic. */
export function promptIndexForDate(dateStr) {
  const n = PROMPTS.length;
  let step = STEP;
  while (gcd(step, n) !== 1) step++;
  const d = daysBetween(EPOCH, dateStr);
  return (((d * step) % n) + n) % n;
}

export function getPromptForDate(dateStr) {
  return PROMPTS[promptIndexForDate(dateStr)];
}

/** A random prompt different from `exceptIndex`. */
export function randomPromptIndex(exceptIndex = -1, rnd = Math.random) {
  if (PROMPTS.length < 2) return 0;
  let i;
  do { i = Math.floor(rnd() * PROMPTS.length); } while (i === exceptIndex);
  return i;
}

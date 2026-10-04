# Nhận người nói qua giọng và nhớ giọng giữa các buổi ghi

Báo cáo nghiên cứu cho ticket T-0089 (Wispra Meeting), viết ngày 04/10/2026. Mỗi ý có nguồn. Những trang không
mở được trực tiếp (lỗi 403) thì lấy từ đoạn trích của công cụ tìm kiếm và ghi "(trích)".

## 1. Tóm tắt và đề xuất

- **Cách làm đã chọn:** chạy trên máy người dùng bằng thư viện **sherpa-onnx** (giấy phép Apache-2.0, không cần tài
  khoản, không tốn phí) với mô hình **CAM++ zh+en của 3D-Speaker** (27 MB, Apache-2.0). Mỗi đoạn lời nói được đổi
  thành một dãy 192 con số đặc trưng cho giọng (gọi là "vector giọng"); hai đoạn của cùng một người cho hai dãy rất
  giống nhau.
- **Cách hoạt động trong Wispra:** khi chủ đặt tên một người nói (gõ tay), hoặc người đó tự giới thiệu trong lời
  (AI ghi nhận ở cột người nói), Wispra lưu vector giọng của các đoạn đó dưới tên người ấy. Buổi sau, đoạn nào có
  giọng giống đủ chắc thì tự ghi tên.
- **Mặc định bật** — quyết định của chủ ngày 04/10/2026 (trước đó bản đầu để mặc định tắt vì giọng là dữ liệu sinh
  trắc học, mục 5). Người dùng tắt được ở Settings → Learned → "Recognise speakers by voice"; ở đó cũng xem danh
  sách giọng đã nhớ, bỏ từng giọng hoặc bỏ hết. Màn hình bắt đầu ghi Meeting có một dòng báo Wispra nhận giọng trên
  máy, không gửi đi đâu, và chỉ chỗ tắt. Lần chạy đầu, mô hình (khoảng 28 MB) được tải ngầm một lần.
- **Không có gì rời máy:** mô hình được tải một lần (kiểm mã SHA-256), chỉ lưu các con số (không lưu âm thanh), được
  mã hoá bằng kho mã hoá của hệ điều hành (Windows DPAPI, macOS Keychain qua Electron `safeStorage`).
- **Không cần trả phí, không cần dịch vụ mới** — nên không có việc chờ chủ về tiền.
- **Hạn chế cần biết:** tiếng Việt và hội thoại thật kém chính xác hơn số liệu chuẩn (mục 4); đoạn dưới 3 giây không
  dùng; một đoạn 20 giây có hai người nói xen nhau sẽ lấy giọng chiếm phần lớn; giọng nghe qua micro và qua loa máy
  tính có thể khác nhau. Ngưỡng hiện đặt thận trọng: thà để "Others" còn hơn ghi sai tên.

## 2. Các sản phẩm đang làm thế nào

| Sản phẩm | Nhớ giọng giữa các buổi? | Lưu ở đâu | Xoá được? | Ghi chú |
|---|---|---|---|---|
| Otter.ai | Có ("Speaker Enrollment": gắn tên người nói là dạy Otter nhận ra người đó lần sau) | Máy chủ Otter | Tắt được cho cả workspace; trang trợ giúp nói chưa xoá được từng người nói, xoá theo cài đặt lưu giữ dữ liệu | Đang bị kiện theo luật BIPA (Illinois) về voiceprint; toà cho vụ kiện tiếp tục |
| Fireflies.ai | Đổi tên người nói theo từng biên bản | Máy chủ | — | Bị kiện BIPA (Cruz v. Fireflies, 12/2025) vì tạo voiceprint của người tham dự không đồng ý |
| tl;dv | Không dùng voiceprint (theo nguồn bên thứ ba): lấy tên từ nền tảng họp | — | — | |
| Microsoft Teams | Có, người dùng tự bật (voice profile) | Kho tuân thủ Office 365 | Xoá ngay khi người dùng tắt; tự xoá sau 1 năm không dùng | **Không hỗ trợ tiếng Việt** khi đăng ký giọng |
| Zoom Rooms | Có, người dùng tự đọc mẫu giọng | Đám mây Zoom | Xoá bất cứ lúc nào | Zoom thường gắn lời theo người đăng nhập, không theo giọng |

Nguồn:
- Otter: https://help.otter.ai/hc/en-us/articles/21665587209367-Speaker-Identification-Overview (trích),
  https://help.otter.ai/hc/en-us/articles/40643231903639-Disable-Speaker-Learning (trích),
  https://help.otter.ai/hc/en-us/articles/40586357592471-Speaker-Management (trích);
  vụ kiện: https://idtechwire.com/otter-ai-must-face-voiceprint-claims-under-illinois-biometric-law/
- Fireflies: https://guide.fireflies.ai/articles/4994477228-how-to-edit-speaker-labels-or-names-in-a-transcript ;
  https://www.dataprivacyandsecurityinsider.com/2025/12/lawsuit-alleges-fireflies-ai-corp-illegally-collects-biometric-data-from-virtual-meetings/
- tl;dv và cách gắn tên chung: https://www.recall.ai/blog/speaker-labels-and-names-explained ; https://tldv.io/blog/ai-meeting-recorder-lawsuits/
- Teams: https://learn.microsoft.com/en-us/microsoftteams/rooms/voice-and-face-recognition
- Zoom Rooms: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0077409

Điểm chung: ai nhớ giọng giữa các buổi đều coi đó là "đăng ký giọng" có thể xoá; Teams và Zoom bắt chính người đó tự
đồng ý. Otter và Fireflies bị kiện vì ghi giọng người khác mà không xin phép.

## 3. Thư viện và dịch vụ

| Lựa chọn | Chạy trên máy? | Miễn phí? | Cần tài khoản/khoá? | Dùng được trong Electron | Giấy phép | Ghi chú |
|---|---|---|---|---|---|---|
| **sherpa-onnx-node** + mô hình 3D-Speaker/WeSpeaker | Có, không cần mạng | Có | Không | Addon native, có sẵn cho Windows x64, macOS arm64/x64 (~23–34 MB) | Apache-2.0 (mã); mô hình Apache-2.0 (3D-Speaker) hoặc CC BY 4.0 (WeSpeaker, NeMo) | Có API tính vector giọng, quản lý người nói, tách người nói |
| sherpa-onnx (WebAssembly) | Có | Có | Không | Có, một luồng (~15 MB) | Apache-2.0 | Chậm hơn; tài liệu chỉ có ví dụ tách người nói |
| Picovoice Eagle | Âm thanh xử lý trên máy, nhưng kiểm khoá qua mạng | Chỉ dùng thử / phi thương mại (không rõ) | Có (AccessKey) | Có SDK Node | SDK Apache-2.0, lõi độc quyền | Không phân phối miễn phí được trong app thương mại |
| pyannote.audio | Có | Có | Cần token Hugging Face | Chỉ Python | MIT / CC BY 4.0 | Mô hình tách đoạn của nó đã có sẵn trong sherpa-onnx |
| SpeechBrain ECAPA | Có | Có | Không | Chỉ Python | Apache-2.0 | |
| AssemblyAI | Không (đám mây) | 50 USD dùng thử rồi trả phí | Có | REST | Độc quyền | Tách người nói trong một tệp; "speaker identification" đoán tên từ nội dung, không nhớ giọng |
| Deepgram | Không (đám mây) | 200 USD dùng thử rồi trả phí | Có | REST | Độc quyền | Tách người nói trong một tệp, không nhớ giọng |
| Groq Whisper | Không | Có gói miễn phí | Có | REST | — | **Không có tách người nói** |
| Azure Speaker Recognition | — | — | — | — | — | **Đã ngừng ngày 30/09/2025** |

Nguồn:
- sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx ; gói npm: https://registry.npmjs.org/sherpa-onnx-node/latest ,
  https://registry.npmjs.org/sherpa-onnx-win-x64/latest , https://registry.npmjs.org/sherpa-onnx-darwin-arm64/latest ;
  ví dụ nhận người nói: https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_speaker_identification.js ;
  danh sách mô hình: https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models
- Mô hình CAM++ zh+en (dùng trong Wispra): https://www.modelscope.cn/api/v1/models/iic/speech_campplus_sv_zh_en_16k-common_advanced ;
  3D-Speaker: https://github.com/modelscope/3D-Speaker ; WeSpeaker: https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md
- Picovoice Eagle: https://github.com/Picovoice/eagle , https://picovoice.ai/docs/quick-start/eagle-nodejs/ , https://picovoice.ai/docs/faq/general/
- pyannote: https://huggingface.co/pyannote/speaker-diarization-3.1 ; SpeechBrain: https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb
- AssemblyAI: https://www.assemblyai.com/docs/speech-to-text/speaker-diarization , https://www.assemblyai.com/docs/speech-understanding/speaker-identification , https://www.assemblyai.com/pricing
- Deepgram: https://developers.deepgram.com/docs/diarization , https://deepgram.com/pricing
- Groq: https://console.groq.com/docs/speech-to-text
- Azure: https://azurecharts.com/updates/story?id=3547

## 4. Độ chính xác và giới hạn thực tế

- **Số liệu chuẩn (tiếng Anh, VoxCeleb1-O, âm thanh sạch):** tỉ lệ lỗi cân bằng (EER) khoảng 0,5–0,8% với các mô hình
  tốt nhất; mô hình CAM++ zh+en dùng trong Wispra: 1,16%. Nguồn: https://github.com/modelscope/3D-Speaker ,
  https://www.modelscope.cn/api/v1/models/iic/speech_campplus_sv_zh_en_16k-common_advanced
- **Tiếng Việt:** trên bộ Vietnam-Celeb, mô hình chỉ học tiếng Anh có EER khoảng 15–18%; học thêm dữ liệu tiếng Việt
  còn khoảng 6–7%. Nguồn: https://arxiv.org/html/2606.24066 ;
  https://www.isca-archive.org/interspeech_2023/pham23b_interspeech.pdf
- **Đoạn ngắn:** từ 3,6 giây xuống 2 giây, lỗi tăng khoảng 46%. Wispra bỏ qua đoạn dưới 3 giây. Nguồn: https://arxiv.org/pdf/2202.01624
- **Kênh khác nhau (micro so với âm thanh từ máy):** lỗi tăng rõ khi giọng mẫu và giọng cần nhận đi qua kênh khác
  nhau. Nguồn: https://arxiv.org/abs/2012.12471
- **Đổi ngôn ngữ:** vector giọng không phụ thuộc lời nói, nhưng đổi ngôn ngữ vẫn làm giảm độ chính xác. Nguồn:
  https://arxiv.org/pdf/2607.01161
- **Đo trên máy này (04/10/2026),** mô hình CAM++ zh+en, hai giọng đọc máy của Windows (David, Zira), 6 câu mỗi giọng:
  cùng một giọng giống nhau 0,86–0,96; khác giọng 0,12–0,27. Wispra đặt ngưỡng 0,60 và yêu cầu hơn giọng thứ hai ít
  nhất 0,08. Giọng máy sạch hơn giọng người thật, nên **cần thử trên buổi ghi thật** và chỉnh ngưỡng nếu cần.

## 5. Quyền riêng tư và pháp lý

- **GDPR (châu Âu):** dữ liệu sinh trắc học dùng để nhận dạng một người (Điều 4(14)); Điều 9 cấm xử lý trừ khi có
  ngoại lệ như đồng ý rõ ràng. https://gdpr-info.eu/art-4-gdpr/ , https://gdpr-info.eu/art-9-gdpr/
- **BIPA (Illinois, Mỹ):** "voiceprint" là dữ liệu sinh trắc; phải báo bằng văn bản và có đồng ý bằng văn bản trước;
  phạt 1.000–5.000 USD mỗi vi phạm. https://ilga.gov/Legislation/ILCS/Articles?ActID=3004&ChapterID=57&Print=True
- **Việt Nam:** Nghị định 13/2023 hết hiệu lực từ 01/01/2026, thay bằng **Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15**
  và Nghị định 356/2025. Dữ liệu sinh trắc học vẫn là dữ liệu nhạy cảm; đồng ý phải tự nguyện, rõ ràng, riêng cho từng
  mục đích, im lặng không phải là đồng ý; dữ liệu sinh trắc phải được mã hoá khi lưu. Nguồn:
  https://www.tilleke.com/insights/new-decree-provides-guidance-for-vietnams-personal-data-protection-law/34/ ,
  https://english.luatvietnam.vn/dan-su/law-on-personal-data-protection-law-no-91-2025-qh15-405135-d1.html ,
  https://www.dlapiperdataprotection.com/?t=law&c=VN
- **Wispra đã làm theo:** mặc định bật theo quyết định của chủ (04/10/2026), có dòng báo ngay trên màn hình bắt đầu ghi
  và lời nhắc "báo cho người được ghi, hoặc tắt đi" trong cài đặt; chỉ lưu con số,
  mã hoá bằng hệ điều hành, chỉ trên máy; xoá từng giọng, xoá hết, xoá buổi ghi thì xoá luôn dữ liệu giọng của buổi đó.
  (Đây không phải tư vấn pháp lý.)

## 6. Quyết định của chủ

- 04/10/2026: **nhận giọng mặc định bật.** Vẫn có chỗ trong cài đặt để tắt, xem và bỏ giọng đã nhớ, và một dòng thông
  báo ngắn cho người dùng biết Wispra nhận giọng trên máy, không gửi đi đâu. Lưu ý pháp lý ở mục 5 (đồng ý rõ ràng với
  dữ liệu sinh trắc học) vẫn đúng: người dùng nên báo cho người được ghi.

## 7. Chưa làm / có thể làm sau

- Thử trên buổi ghi thật bằng tiếng Việt và chỉnh ngưỡng.
- Tách giọng theo kênh (micro / máy) và theo từng đoạn ngắn trong một đoạn 20 giây (tách người nói đầy đủ — sherpa-onnx
  có sẵn `OfflineSpeakerDiarization`).
- Tự xoá giọng không dùng sau một năm (như Teams).
- Máy Mac: addon được cài theo kiến trúc của máy build; bản Mac universal chỉ chạy được tính năng này trên kiến trúc đó
  (Apple Silicon nếu máy build là Apple Silicon). Phải kiểm bản build Mac ở lần phát hành tới.

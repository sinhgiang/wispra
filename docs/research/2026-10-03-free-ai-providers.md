# Nhà cung cấp AI miễn phí cho Mind map và dàn ý Transcript (T-0038)

Ngày xem các nguồn: **2026-10-03**. Chỉ nghiên cứu: không tạo tài khoản, không đăng ký, không đọc khoá, không sửa code.

## Wispra cần gì

- Mind map và dàn ý Transcript đọc bản chép lời dài theo từng phần (khoảng 12.000 ký tự, tức khoảng 4.000 đến 6.000
  token mỗi phần), mỗi lần gọi trả về JSON.
- Một buổi ghi 2 tiếng rưỡi tốn khoảng 160.000 token đầu vào cho Mind map, cộng phần trả lời. Dàn ý Transcript tốn thêm
  khoảng 53.000 token đầu vào.
- Mô hình đang dùng: `openai/gpt-oss-120b` trên Groq. Code gọi theo kiểu OpenAI (`/chat/completions`), nên nhà cung cấp
  nào cũng theo kiểu này thì thêm vào rất ít việc.
- Đã có sẵn trong app: tự chờ khi chạm giới hạn theo phút, giữ phần đã xong, hỏi lại khi JSON hỏng (lần cuối không dùng
  chế độ JSON), và báo đúng giới hạn theo ngày (T-0037).

## So sánh

| Nhà cung cấp | Mô hình tốt nhất ở gói miễn phí | Giới hạn miễn phí | Độ dài đầu vào | Trả JSON | Dữ liệu và dùng thương mại | Vùng (châu Âu) | Phải nhập thẻ? | Nguồn (xem 2026-10-03) |
|---|---|---|---|---|---|---|---|---|
| **Groq** (đang dùng) | `openai/gpt-oss-120b` | 30 lần/phút, 1.000 lần/ngày, 8.000 token/phút, **200.000 token/ngày**. `gpt-oss-20b` và `qwen3.8-27b` có hạn mức riêng cùng mức. | 131k (theo trang mô hình, không xem lại hôm nay) | Có (chế độ JSON; đôi khi báo "Failed to generate JSON") | Dùng thương mại được (khoá riêng của người dùng) | Không thấy hạn chế vùng | Không | https://console.groq.com/docs/rate-limits |
| **Cerebras** | `gpt-oss-120b`, **đúng mô hình đang dùng** | 5 lần/phút, 30.000 token/phút chưa cache (90.000 tính cả cache), 1 triệu token/giờ, **1 triệu token/ngày** | **65.000 token** ở gói miễn phí (131k ở gói trả tiền); trả lời tối đa 32.000 token | Có ("Structured Outputs") | Điều khoản chung: không dùng nội dung của khách để huấn luyện mô hình. Không thấy cấm dùng thương mại; chưa đọc được điều khoản riêng của API. | Không ghi; trang chỉ nói không cam kết dùng được ngoài Mỹ | Gói miễn phí: trang không ghi rõ. Thêm thẻ chỉ để nhận 5 USD tín dụng (hết hạn sau 30 ngày). | https://inference-docs.cerebras.ai/support/rate-limits, https://inference-docs.cerebras.ai/models/openai-oss, https://inference-docs.cerebras.ai/quickstart, https://www.cerebras.ai/terms-of-service, https://www.cerebras.ai/pricing |
| **Google Gemini API** | Gemini 2.5 Flash / 2.5 Pro / dòng Gemini 3 Flash | Có gói miễn phí, nhưng **trang chính thức không ghi con số**; chỉ xem được trong AI Studio của từng tài khoản. Giới hạn theo ngày đặt lại lúc nửa đêm giờ Thái Bình Dương. | Rất dài (không xem lại con số hôm nay) | Có (structured output) | **Gói miễn phí dùng dữ liệu để cải thiện sản phẩm, có người đọc**; Google dặn không gửi thông tin nhạy cảm hay cá nhân. | **Ứng dụng phục vụ người dùng ở EEA, Thuỵ Sĩ, Anh chỉ được dùng gói trả tiền.** | Không (gói miễn phí). Phải từ 18 tuổi. | https://ai.google.dev/gemini-api/docs/rate-limits, https://ai.google.dev/gemini-api/docs/pricing, https://ai.google.dev/gemini-api/terms |
| **Cloudflare Workers AI** | `@cf/openai/gpt-oss-120b`, **đúng mô hình đang dùng** | **10.000 "neuron"/ngày** cho cả gói miễn phí lẫn trả tiền. Với gpt-oss-120b, 1 triệu token vào tốn 31.818 neuron và 1 triệu token ra tốn 68.182 neuron, nên chỉ khoảng 300.000 token vào/ngày nếu không tính token ra. Thực tế khoảng 35 phần Mind map/ngày, tương đương Groq. | Không xem hôm nay | Chưa xác minh | Chưa xem điều khoản dữ liệu | Chưa xem | Tài khoản Cloudflare miễn phí; chưa xác minh có cần thẻ không | https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| **OpenRouter** (mô hình `:free`) | Tuỳ mô hình miễn phí đang có (thay đổi theo thời gian) | **20 lần/phút, 50 lần/ngày** khi tổng tiền đã nạp dưới 10 USD; **1.000 lần/ngày** khi đã nạp từ 10 USD trở lên. Buổi ghi 2 tiếng rưỡi cần khoảng 9 đến 12 lần gọi, tức khoảng 4 Mind map/ngày ở mức 50. | Tuỳ mô hình | Tuỳ mô hình và nơi chạy | Tuỳ nơi chạy mô hình; trang giới hạn không nói về lưu hay huấn luyện | Chưa xem | Không (mức 50 lần/ngày) | https://openrouter.ai/docs/api-reference/limits |
| **Mistral** | Mistral (Small / Medium) | Trang giá ghi gói miễn phí có "$10/mo in API credits". Không ghi giới hạn tốc độ. | Không xem hôm nay | Có (JSON mode của Mistral, không xem lại hôm nay) | Trang giá không nói về huấn luyện. Công ty ở Pháp. | Châu Âu | Trang giá không ghi | https://mistral.ai/pricing (trang tài liệu về các gói trả 404 hôm nay) |
| GitHub Models | — | **Đã ngừng ngày 2026-07-30** theo trang chính thức. Loại. | | | | | | https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models |

Về chất lượng:
- Cerebras và Cloudflare chạy **đúng `gpt-oss-120b`**, nên chất lượng như hiện nay. Không cần sửa câu lệnh gửi cho AI.
- Gemini 2.5 Flash và Gemini 3 Flash: theo đánh giá của tôi (không có số đo trên dữ liệu của Wispra), viết tiếng Việt và
  tóm tắt văn bản dài tốt ngang hoặc hơn `gpt-oss-120b`. Muốn chắc thì phải thử trên bản chép lời thật.
- OpenRouter và Mistral: tuỳ mô hình chọn; chưa đánh giá.

## Đề xuất

### Lựa chọn 1 (nên làm): Cerebras làm nhà cung cấp thứ hai cho các việc AI dài

Ưu điểm:
- Cùng mô hình `gpt-oss-120b`, nên chất lượng và câu lệnh giữ nguyên.
- Gói miễn phí cho **1 triệu token/ngày, gấp 5 lần Groq**. Đủ cho khoảng 4 đến 5 buổi ghi 2 tiếng rưỡi mỗi ngày (cả Mind
  map lẫn dàn ý).
- Điểm cuối theo kiểu OpenAI: `https://api.cerebras.ai/v1/chat/completions`.
- Hỗ trợ structured output.
- Điều khoản chung ghi không dùng nội dung để huấn luyện.

Nhược điểm:
- Chỉ 5 lần gọi/phút. App đã tự chờ khi chạm giới hạn này, nên chỉ chậm hơn chứ không lỗi; Mind map 9 phần mất khoảng 2
  phút.
- Đầu vào tối đa 65.000 token ở gói miễn phí. Mỗi phần của Wispra chỉ khoảng 5.000 token nên không ảnh hưởng; câu hỏi chat
  về buổi ghi rất dài thì có thể chạm.
- Trang chính thức chưa nói rõ đăng ký gói miễn phí có cần thẻ không, cũng không nói về vùng (châu Âu) hay điều khoản riêng
  của API. Phải xem lúc đăng ký.
- Cerebras không có dịch vụ chuyển giọng nói, nên chuyển giọng nói vẫn ở Groq.

Việc cần làm trong Wispra (ước chừng một nhánh, một pull request):
1. Cài đặt mới "Nhà cung cấp cho việc AI dài" (Mind map, dàn ý Transcript, có thể cả bài viết): "Giống chuyển giọng nói"
   hoặc "Cerebras". Kèm ô nhập khoá Cerebras ở trang Account, lưu như khoá Groq: không hiện giá trị, thử khoá trước khi
   lưu.
2. `resolveChatTarget` (`postprocess.ts`) trả về `https://api.cerebras.ai/v1` và model `gpt-oss-120b` cho các việc đó
   khi đã chọn Cerebras.
3. Tuỳ chọn: tự chuyển sang Cerebras khi Groq báo hết giới hạn theo ngày (đã đọc được từ T-0037), và báo cho người dùng
   biết.
4. Bộ kiểm tra mới với máy chủ giả, theo kiểu đã có: gọi đúng điểm cuối, xử lý 429 của Cerebras (5 lần/phút), tự chuyển
   khi hết giới hạn ngày.
5. Thử thật một lần với khoá của chủ trên một buổi ghi dài. Chủ tự chạy; tôi không đọc khoá.

Chủ cần đăng ký:
- Tạo tài khoản ở https://cloud.cerebras.ai và tạo một API key. Khi đăng ký, xem có bị hỏi thẻ không (không bắt buộc nếu
  chỉ dùng gói miễn phí; thẻ chỉ để nhận 5 USD).
- Sau khi tính năng được làm: dán khoá vào trang Account của Wispra.

### Lựa chọn 2 (không tốn đăng ký mới): dùng thêm mô hình khác của Groq

Bảng chính thức ghi hạn mức tính **theo từng mô hình**: `gpt-oss-120b`, `gpt-oss-20b` và `qwen3.8-27b` mỗi cái có 200.000
token/ngày riêng. Khi `gpt-oss-120b` hết giới hạn ngày, app có thể tự chuyển sang `gpt-oss-20b` cho các phần còn lại.
- Ưu điểm: không phải đăng ký gì; cùng khoá Groq; làm nhanh.
- Nhược điểm: mô hình nhỏ hơn nên Mind map kém hơn một chút (chưa đo); chỉ thêm được 200.000 token/ngày.
- Việc cần làm: khi gặp `daily-limit` của `gpt-oss-120b` thì thử lại phần đó với `gpt-oss-20b`, ghi rõ trên sơ đồ là đã
  dùng mô hình dự phòng; có test.

### Không nên dùng làm mặc định

- **Gemini gói miễn phí:** Google dùng dữ liệu để cải thiện sản phẩm và có người đọc. Bản ghi cuộc họp là dữ liệu nhạy
  cảm. Ngoài ra điều khoản cấm dùng gói miễn phí cho ứng dụng phục vụ người dùng ở EEA, Thuỵ Sĩ, Anh, mà Wispra là sản
  phẩm toàn cầu. Chỉ hợp cho chủ tự thử riêng.
- **OpenRouter miễn phí:** 50 lần/ngày quá ít. Lên 1.000 lần/ngày phải nạp 10 USD (việc tiền, chủ quyết). Mô hình miễn phí
  thay đổi theo thời gian.
- **Cloudflare:** cùng mô hình nhưng hạn mức ngày chỉ ngang Groq, lại cần cả mã tài khoản lẫn token. Chỉ đáng thêm nếu cần
  nhà cung cấp thứ ba.
- **Mistral:** trang giá có 10 USD tín dụng API mỗi tháng, nhưng chưa xác minh được giới hạn tốc độ và điều khoản dữ liệu.
  Đáng xem lại nếu cần nhà cung cấp ở châu Âu.

## Chưa xác minh

- Cerebras: có phải nhập thẻ để có gói miễn phí không; điều khoản riêng của API (lưu dữ liệu bao lâu, vùng).
- Gemini: con số giới hạn miễn phí (chỉ có trong AI Studio của tài khoản).
- Cloudflare: điều khoản dữ liệu, có cần thẻ không, hỗ trợ chế độ JSON.
- Mistral: giới hạn tốc độ của gói miễn phí và điều khoản dữ liệu (trang tài liệu trả lỗi 404 hôm nay).
- Chất lượng thật của các mô hình khác `gpt-oss-120b` trên bản chép lời tiếng Việt của Wispra: chưa thử.

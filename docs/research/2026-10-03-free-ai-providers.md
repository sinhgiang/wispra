# Nhà cung cấp AI miễn phí cho Mind map và dàn ý Transcript (T-0038)

Ngày xem các nguồn: **2026-10-03**. Chỉ nghiên cứu: không tạo tài khoản, không đăng ký, không đọc khoá, không sửa code.

> **Sửa lại cùng ngày 2026-10-03:** bản đầu của báo cáo này **sai về Cerebras**.
>
> - Bảng "Free Trial Rate Limits" của Cerebras chỉ là giới hạn của gói **dùng thử 5 USD**, không phải gói miễn phí. Tôi
>   đã đọc nhầm nó thành gói miễn phí.
> - Trang chính thức ghi rõ: "No. The Free Trial is time- and credit-bounded: $5 in credits that expire 30 days after
>   they're granted." và "Cerebras doesn't currently offer a no-cost tier that renews automatically or a per-model
>   always-free allowance."
> - Trang đó cũng ghi: "If you skip adding a payment method at sign-up, Playground and API access remain inactive until
>   you do." Chủ thấy đúng như vậy khi tạo tài khoản.
>
> Vì vậy **Cerebras cần thẻ và không còn là lựa chọn miễn phí**. Phần so sánh và đề xuất bên dưới đã sửa theo. Các nhà
> cung cấp khác đã được xem lại trên trang chính thức cùng ngày.

## Wispra cần gì

- Mind map và dàn ý Transcript đọc bản chép lời dài theo từng phần (khoảng 12.000 ký tự, tức khoảng 4.000 đến 6.000
  token mỗi phần), mỗi lần gọi trả về JSON.
- Một buổi ghi 2 tiếng rưỡi tốn khoảng 160.000 token đầu vào cho Mind map, cộng phần trả lời. Dàn ý Transcript tốn thêm
  khoảng 53.000 token đầu vào.
- Mô hình đang dùng: `openai/gpt-oss-120b` trên Groq. Code gọi theo kiểu OpenAI (`/chat/completions`).
- Đã có sẵn trong app: tự chờ khi chạm giới hạn theo phút, giữ phần đã xong, hỏi lại khi JSON hỏng, và báo đúng giới
  hạn theo ngày (T-0037).

## So sánh (xem lại trên trang chính thức ngày 2026-10-03)

| Nhà cung cấp | Mô hình ở mức miễn phí | Giới hạn miễn phí | Trả JSON | Dữ liệu và dùng thương mại | Vùng (châu Âu) | Phải nhập thẻ? | Nguồn |
|---|---|---|---|---|---|---|---|
| **Groq** (đang dùng) | `openai/gpt-oss-120b`; `openai/gpt-oss-20b` và `qwen3.8-27b` có hạn mức riêng | Mỗi mô hình: 30 lần/phút, 1.000 lần/ngày, 8.000 token/phút, **200.000 token/ngày** | Có (đôi khi báo "Failed to generate JSON", app đã xử lý) | Dùng thương mại được với khoá riêng của người dùng | Không thấy hạn chế | Trang giới hạn không nói gì về thẻ; chủ đang dùng không cần thẻ | https://console.groq.com/docs/rate-limits |
| **Cerebras** | `gpt-oss-120b` (đúng mô hình đang dùng) | **Không có gói miễn phí.** Chỉ có 5 USD dùng thử, hết hạn sau 30 ngày, sau khi thêm thẻ. Không thêm thẻ thì API không chạy. | Có (structured output) | Điều khoản chung: không dùng nội dung để huấn luyện | Không ghi | **Có, bắt buộc** | https://inference-docs.cerebras.ai/support/rate-limits, https://inference-docs.cerebras.ai/models/openai-oss |
| **Cloudflare Workers AI** | `@cf/openai/gpt-oss-120b` (đúng mô hình đang dùng) | **10.000 "neuron"/ngày** ở gói Workers Free. 1 triệu token vào tốn 31.818 neuron, 1 triệu token ra tốn 68.182 neuron, nên dùng hết là khoảng 200.000 đến 300.000 token/ngày, ngang Groq. Hết thì báo lỗi tới hôm sau, hoặc phải lên gói trả tiền. | Chưa xác minh | Chưa xem điều khoản dữ liệu | Chưa xem | **Không** ("No payment method is required to use Workers AI on the Free plan"; vài mô hình như Kimi, DeepSeek thì cần) | https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| **Google Gemini API** | Gemini 2.5 Flash, Gemini 3.8 Flash (mới nhất trong bảng giá), … | Gói miễn phí ghi "Free of charge"; con số giới hạn chỉ xem được trong AI Studio của từng tài khoản. Giới hạn theo ngày đặt lại lúc nửa đêm giờ Thái Bình Dương. | Có (structured output) | **Gói miễn phí: "Used to improve our products: Yes", có người đọc**; Google dặn không gửi thông tin nhạy cảm hay cá nhân | **Ứng dụng phục vụ người dùng ở EEA, Thuỵ Sĩ, Anh chỉ được dùng gói trả tiền** | Trang giá không nói phải có thẻ cho gói miễn phí. Phải từ 18 tuổi. | https://ai.google.dev/gemini-api/docs/pricing, https://ai.google.dev/gemini-api/docs/rate-limits, https://ai.google.dev/gemini-api/terms |
| **OpenRouter** (mô hình `:free`) | Tuỳ mô hình miễn phí đang có | **20 lần/phút, 50 lần/ngày** nếu tổng đã nạp dưới 10 USD; 1.000 lần/ngày nếu đã nạp từ 10 USD | Tuỳ mô hình | Tuỳ nơi chạy | Chưa xem | Trang giới hạn không nói | https://openrouter.ai/docs/api-reference/limits |
| **Mistral** | Mô hình Mistral | Trang giá: gói Free (Le Chat / Vibe) có "$10 /mo in API credits". Không ghi giới hạn tốc độ. | Có (không xem lại hôm nay) | Trang giá không nói về huấn luyện. Công ty ở Pháp. | Châu Âu | Trang giá không nói | https://mistral.ai/pricing |
| GitHub Models | — | **Đã ngừng ngày 2026-07-30** theo trang chính thức. Loại. | | | | | https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models |

Về chất lượng:
- Cloudflare và Cerebras chạy **đúng `gpt-oss-120b`**, nên chất lượng như hiện nay.
- `gpt-oss-20b` của Groq là mô hình nhỏ hơn của cùng dòng. Sơ đồ có thể kém hơn một chút; chưa đo.
- Gemini Flash: theo đánh giá của tôi (không có số đo trên dữ liệu của Wispra), viết tiếng Việt và tóm tắt văn bản dài
  tốt ngang hoặc hơn `gpt-oss-120b`.
- OpenRouter và Mistral: tuỳ mô hình chọn; chưa đánh giá.

## Đề xuất (đã sửa)

### Lựa chọn 1 (không cần đăng ký gì): dùng thêm `gpt-oss-20b` của Groq khi `gpt-oss-120b` hết giới hạn ngày

Bảng chính thức của Groq ghi hạn mức **tính riêng cho từng mô hình**. Khi `gpt-oss-120b` hết 200.000 token trong ngày,
app có thể tự chạy tiếp các phần còn lại bằng `gpt-oss-20b`, có thêm 200.000 token/ngày nữa.

- Ưu: cùng khoá Groq, chủ không phải đăng ký gì, làm nhanh, miễn phí.
- Nhược: chỉ gấp đôi số token mỗi ngày, và mô hình nhỏ hơn nên chất lượng có thể kém hơn một chút (chưa đo).
- Việc cần làm trong Wispra:
  1. Khi gặp giới hạn ngày (phần đọc giới hạn ngày đã có từ T-0037), gọi lại phần đó bằng `gpt-oss-20b` cho Mind map và
     dàn ý.
  2. Ghi rõ trên sơ đồ hoặc dàn ý là đã dùng mô hình dự phòng.
  3. Thêm test với máy chủ giả.
- Chủ cần đăng ký: không gì cả.

### Lựa chọn 2 (miễn phí, không cần thẻ theo trang chính thức): Cloudflare Workers AI làm nhà cung cấp thứ hai

- Ưu: chạy đúng `gpt-oss-120b`, gói Free không cần thẻ, mỗi ngày được thêm khoảng ngang một ngày của Groq.
- Nhược: chỉ khoảng 200.000 đến 300.000 token/ngày. Cần cả mã tài khoản lẫn API token. Chưa xác minh chế độ JSON và điều
  khoản dữ liệu.
- Việc cần làm trong Wispra:
  1. Thêm "Cloudflare" vào chỗ chọn nhà cung cấp cho việc AI dài, với ô nhập mã tài khoản và token ở trang Account.
  2. Gọi điểm cuối kiểu OpenAI của Workers AI (cần xác minh đường dẫn đúng trên tài liệu Cloudflare trước khi làm).
  3. Tự chuyển khi Groq hết giới hạn ngày; thêm test.
- Chủ cần đăng ký: tài khoản Cloudflare miễn phí, tạo một API token có quyền Workers AI. Lấy mã tài khoản trong trang
  quản trị.

Có thể làm cả hai: thử Groq `gpt-oss-20b` trước, rồi tới Cloudflare. Tổng cộng khoảng 3 lần Groq hiện nay mỗi ngày mà không
tốn tiền.

### Nếu chấp nhận trả tiền hoặc thêm thẻ (chủ quyết)

- **Cerebras:** thêm thẻ để nhận 5 USD dùng thử trong 30 ngày, sau đó trả theo mức dùng. Cùng mô hình, rất nhanh.
- **Wispra Cloud:** đã có sẵn trong app (T-0029). Dùng khoá Groq của máy chủ, tức là tiền của chủ.
- **Groq trả tiền:** nâng gói Groq của khoá riêng.

### Không nên dùng làm mặc định

- **Gemini miễn phí:** Google dùng dữ liệu để cải thiện sản phẩm và có người đọc, trong khi bản ghi cuộc họp là dữ liệu
  nhạy cảm. Điều khoản cũng cấm dùng gói miễn phí cho ứng dụng phục vụ người dùng EEA, Thuỵ Sĩ, Anh. Chỉ hợp cho chủ tự
  thử riêng.
- **OpenRouter miễn phí:** 50 lần gọi/ngày quá ít; lên 1.000 lần phải nạp 10 USD.
- **Mistral:** trang giá ghi 10 USD tín dụng API mỗi tháng ở gói Free, nhưng chưa rõ có cần thẻ hay xác minh số điện thoại
  không, giới hạn tốc độ thế nào, dữ liệu có bị dùng để huấn luyện không. Đáng kiểm tra thêm nếu cần nhà cung cấp ở châu
  Âu.

## Chưa xác minh

- Groq: trang chính thức không nói rõ gói miễn phí có cần thẻ không. Chủ đang dùng mà không có thẻ.
- Cloudflare: chế độ JSON với `gpt-oss-120b`, điều khoản dữ liệu, vùng, đường dẫn điểm cuối kiểu OpenAI.
- Gemini: con số giới hạn miễn phí (chỉ có trong AI Studio).
- Mistral: thẻ hay số điện thoại, giới hạn tốc độ, điều khoản dữ liệu của 10 USD tín dụng mỗi tháng.
- Chất lượng thật của `gpt-oss-20b` và các mô hình khác trên bản chép lời tiếng Việt của Wispra: chưa thử.
- Hai nguồn ngoài Chief đưa (github.com/robhunter/agentdeals issue 1910; pricepertoken.com) tôi không mở. Phần sửa về
  Cerebras dựa trên trang chính thức của Cerebras.

# Chữ hiện ngay khi nói trong Meeting (chữ tạm)

Ghi chú so sánh cho ticket T-0092, viết ngày 04/10/2026. Mỗi ý có nguồn.

## 1. Kết luận

- **Cách đã làm:** chạy trên máy, miễn phí. Dùng thư viện sherpa-onnx (đã có trong Wispra từ T-0089, Apache-2.0) với mô hình
  tiếng Việt **`sherpa-onnx-zipformer-vi-int8-2025-04-20`** (Apache-2.0, khoảng 77 MB, tải một lần khi bắt đầu ghi, kiểm
  SHA-256). Mô hình này không chạy theo luồng, nên Wispra làm "giả luồng" như sherpa-onnx hướng dẫn: đoạn đang nói được
  giải mã lại liên tục khi dài thêm; đoạn dài hơn 6 giây thì phần đầu được chốt tại một chỗ ngắt hơi để mỗi lần giải mã
  luôn ngắn. Chữ tạm hiện màu xám nghiêng ở cuối bảng, rồi bị thay bằng chữ của Groq khi đoạn đó chép xong. Người nói,
  mục chính, hành động vẫn như cũ (chúng làm việc trên chữ của Groq).
- **Số đo trên máy này** (âm thanh tiếng Việt mẫu đưa vào từng 250 ms theo đúng nhịp thời gian thực, `npm run check:live-words`):
  mỗi lần giải mã 50–81 ms; từ lúc một phần âm thanh tới tiến trình chính đến lúc chữ của nó lên màn hình tối đa
  **302–325 ms**, kể cả một đoạn nói liền 20 giây. Cộng 250 ms gom âm thanh ở bộ ghi, chữ hiện **khoảng 0,6 giây** sau khi
  nói. Chữ tạm cuối cùng trùng với giải mã cả đoạn một lần.
- **Giới hạn:** mô hình chỉ biết tiếng Việt — khi chọn ngôn ngữ nói khác (ví dụ English) thì không hiện chữ tạm; từ tiếng
  Anh xen giữa sẽ sai trong chữ tạm cho tới khi Groq thay. Chữ tạm viết thường, không dấu câu. Chưa đo độ chính xác trên
  giọng của chủ (mô hình không công bố WER).
- **Bật sẵn**, tắt ở màn hình bắt đầu ghi ("Show words as they are spoken").
- **Không cần trả phí, không cần dịch vụ mới** — nên không có việc chờ chủ.

## 2. Vì sao không dùng Groq cho chữ tạm

- Gói miễn phí của `whisper-large-v3` và `-turbo`: 20 yêu cầu/phút, 2.000 yêu cầu/ngày, 7.200 giây âm thanh/giờ,
  28.800 giây/ngày. https://console.groq.com/docs/rate-limits
- Mỗi yêu cầu bị tính tối thiểu 10 giây âm thanh. https://console.groq.com/docs/speech-to-text
- Gửi mỗi 1–2 giây là vượt: 20 yêu cầu/phút chỉ cho một yêu cầu mỗi 3 giây; 20 × 60 × 10 giây = 12.000 giây/giờ > 7.200;
  2.000 yêu cầu/ngày hết sau khoảng 100 phút. Các đoạn 20 giây hiện tại đã dùng một nửa hạn mức giây/giờ.

## 3. So sánh các cách

| Cách | Miễn phí? | Chạy trên máy? | Tiếng Việt? | Độ trễ chữ tạm | Dung lượng | Giấy phép | Ghi chú |
|---|---|---|---|---|---|---|---|
| **sherpa-onnx + zipformer-vi-int8-2025-04-20, giả luồng (đã chọn)** | Có | Có | Có (chỉ tiếng Việt) | Đo được ~0,3 s sau khi âm thanh tới (~0,6 s sau khi nói) | ~77 MB | Apache-2.0 | Thư viện đã có sẵn |
| sherpa-onnx zipformer-vi-30M-int8-2026-02-09 | Có | Có | Có | Nhanh hơn (RTF 0,011) | ~32 MB | CC-BY-NC-ND (phi thương mại) | WER công bố tốt nhất 8–12% nhưng không dùng thương mại được |
| Mô hình luồng cộng đồng zh-en-vi (lmcu000) | Có | Có | Có + tiếng Anh xen | Luồng thật | ~130 MB | CC BY-NC-SA (phi thương mại) | WER tiếng Việt 15–24% |
| Moonshine tiny/base tiếng Việt | Có | Có | Có | ~0,2–0,5 s | ~35–60 MB | Moonshine Community (phi thương mại) | FLEURS WER 13% |
| Vosk small-vn | Có | Có | Có | Luồng thật | 32 MB | Apache-2.0 | WER 15,7%; gói Node dùng ffi-napi, không chạy trên Electron ≥ 21 |
| whisper.cpp stream (tiny/base/small) | Có | Có | Kém (tiny 92%, small 23% WER FLEURS) | Tốn CPU | 75–466 MiB | MIT | Thêm thư viện native mới |
| Web Speech API của trình duyệt | — | — | — | — | — | — | Không chạy trong Electron |
| Groq mỗi 1–2 s | Không (vượt hạn mức miễn phí) | Không | Có | ≥ 3 s giữa các yêu cầu | — | — | Xem mục 2 |
| Deepgram Nova-2/3 (luồng) | Không (200 USD dùng thử) | Không | Có | Vài trăm ms (theo hãng) | — | Độc quyền | Nova-3 khoảng 0,0048–0,0058 USD/phút |
| AssemblyAI | Không | Không | Chỉ bản Universal-3.5 Pro | — | — | Độc quyền | |
| Google Cloud STT | 60 phút/tháng rồi trả phí | Không | Có | — | — | Độc quyền | 0,016 USD/phút, tính theo bước 15 s |
| Azure Speech | 5 giờ/tháng (F0) rồi trả phí | Không | Có | — | — | Độc quyền | khoảng 1 USD/giờ |
| Soniox | Không | Không | Có | dưới 200 ms (theo hãng) | — | Độc quyền | 0,12 USD/giờ |
| Speechmatics | 480 phút/tháng (nguồn phụ) | Không | Có | — | — | Độc quyền | |

Nguồn:
- Mô hình sherpa-onnx tiếng Việt: https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/zipformer-transducer-models.html ;
  tệp đã dùng: https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-vi-int8-2025-04-20 ; giấy phép gốc Apache-2.0:
  https://huggingface.co/zzasdf/viet_iter3_pseudo_label ; mô hình 30M: https://huggingface.co/hynt/Zipformer-30M-RNNT-6000h
- Giả luồng của sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/sherpa-onnx-vad-microphone-simulated-streaming-asr.cc ;
  ví dụ Node: https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples
- Danh sách mô hình luồng chính thức (không có tiếng Việt): https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html ;
  mô hình cộng đồng: https://huggingface.co/lmcu000/sherpa-onnx-streaming-zipformer-zh-en-vi-2e
- Moonshine: https://arxiv.org/html/2509.02523v1 , https://github.com/moonshine-ai/moonshine
- Vosk: https://alphacephei.com/vosk/models ; lỗi Electron: https://github.com/alphacep/vosk-api/issues/1962
- whisper.cpp: https://github.com/ggml-org/whisper.cpp/tree/master/examples/stream ; WER tiếng Việt: https://arxiv.org/html/2509.02523v1
- Web Speech API trong Electron: https://github.com/electron/electron/issues/7749
- Deepgram: https://developers.deepgram.com/docs/models-languages-overview , https://deepgram.com/pricing
- AssemblyAI: https://www.assemblyai.com/docs/faq/language-support-for-real-time-transcription
- Google: https://cloud.google.com/speech-to-text/pricing
- Azure: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support , https://azure.microsoft.com/en-us/pricing/details/speech/
- Soniox: https://soniox.com/pricing ; Speechmatics: https://docs.speechmatics.com/speech-to-text/languages

## 4. Nếu chất lượng chữ tạm chưa đủ

- Thử trên buổi ghi thật của chủ trước. Nếu cần tốt hơn mà vẫn miễn phí: mô hình 30M (tốt hơn) chỉ dùng được nếu Wispra
  không bán; còn lại là dịch vụ trả phí (Deepgram Nova-3 rẻ nhất có tiếng Việt theo luồng) — việc đó cần chủ quyết.

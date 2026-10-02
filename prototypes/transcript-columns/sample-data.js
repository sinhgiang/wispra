/*
 * Sample data for the four-column Transcript design prototype (ticket T-0021).
 * Everything here is invented: a 42-minute planning meeting, in Vietnamese, of a small
 * team preparing a course launch.
 *
 * The shapes mirror what the real build would store on a MeetingSession:
 *   - PARAGRAPHS: the transcript as it is today (paragraph blocks built from segments),
 *     plus an optional speaker.
 *   - TOPICS: AI-made section titles, each covering a run of paragraphs (from..to, 1-based).
 *   - ACTIONS: AI-extracted action items, each pointing at the paragraph it comes from.
 */
;(function () {
  const ms = (t) => {
    const p = t.split(':').map(Number)
    return (p.length === 3 ? (p[0] * 60 + p[1]) * 60 + p[2] : p[0] * 60 + p[1]) * 1000
  }

  const SESSION = { title: 'Họp chuẩn bị ra mắt khoá học tháng 11', createdAt: 'T6, 2 thg 10, 2026 · 14:05', durationMs: ms('42:15'), startClock: [14, 5] }

  // How a name got attached to a voice. 'self' = the person said their own name;
  // 'introduced' = someone else introduced them just before they spoke; null = not named.
  const SPEAKERS = {
    son: { name: 'Sơn', hue: 262, source: 'self', quote: '“mình là Sơn”', at: '00:20' },
    linh: { name: 'Linh', hue: 172, source: 'introduced', quote: '“mời Linh báo cáo”', at: '04:10' },
    s3: { name: 'Người nói 3', hue: 28, source: null }
  }

  const P = (time, speaker, text) => ({ time, speaker, text })
  const blocks = [
    P('00:20', 'son', 'Chào cả nhà, mình là Sơn, hôm nay mình điều phối buổi họp. Mục tiêu của buổi này là chốt ba việc: kết quả đợt mở bán thử vừa rồi, nội dung và lịch học của khoá tháng 11, và kế hoạch truyền thông cho bốn tuần tới.'),
    P('02:05', 'son', 'Mình muốn cuối buổi mỗi việc đều có người nhận và có ngày xong. Buổi trước mình bàn rất nhiều nhưng không ai ghi lại ai làm gì, nên hai tuần sau gần như không có gì thay đổi. Lần này mình làm khác đi.'),
    P('04:10', 'son', 'Bây giờ mời Linh báo cáo kết quả đợt mở bán thử trước nhé.'),
    P('04:32', 'linh', 'Vâng. Đợt mở bán thử chạy bảy ngày, có 1.240 lượt vào trang đăng ký và 86 người đăng ký, tức là khoảng 7 phần trăm. Trong 86 người đó có 31 người đã chuyển khoản, doanh thu là 46 triệu rưỡi. So với mục tiêu 40 người thì mình mới đạt gần 80 phần trăm.'),
    P('09:18', 'linh', 'Điểm đáng chú ý là phần lớn người bỏ ngang ở bước thanh toán. Có 22 người bấm đăng ký nhưng không chuyển khoản, và khi em nhắn hỏi thì nhiều người nói là không rõ học xong thì làm được gì. Em nghĩ trang đăng ký đang nói quá nhiều về nội dung mà thiếu kết quả đầu ra.'),
    P('13:30', 'son', 'Rõ rồi. Vậy mình sang phần nội dung. Khoá tháng 11 mình đề xuất rút từ tám buổi xuống sáu buổi, mỗi buổi chín mươi phút, học tối thứ Ba và thứ Năm. Hai buổi bỏ đi là phần lý thuyết, mình chuyển thành video xem trước.'),
    P('16:45', 's3', 'Em thấy rút xuống sáu buổi thì hợp lý, nhưng buổi thực hành triển khai lên máy chủ đang bị dồn vào cuối. Lần trước học viên kẹt nhiều nhất ở đó. Em đề nghị đưa lên buổi thứ ba, và có thêm một buổi hỏi đáp tự chọn vào Chủ nhật.'),
    P('19:20', 'linh', 'Em đồng ý với việc thêm buổi hỏi đáp. Ngoài ra bộ tài liệu hướng dẫn cài đặt hiện có ba bản khác nhau nằm rải rác, học viên mới không biết đọc bản nào. Nên gộp lại thành một bản duy nhất trước ngày khai giảng.'),
    P('21:50', 'son', 'Được. Mình chốt là sáu buổi, buổi triển khai đưa lên thứ ba, thêm một buổi hỏi đáp Chủ nhật. Ngày khai giảng là thứ Ba, mùng 10 tháng 11.'),
    P('24:05', 'son', 'Sang phần truyền thông. Mình còn đúng bốn tuần. Ý của mình là mỗi tuần một chủ đề: tuần đầu kể câu chuyện học viên cũ, tuần hai là buổi chia sẻ trực tiếp miễn phí, tuần ba mở đăng ký sớm có ưu đãi, tuần bốn là nhắc hạn chót.'),
    P('28:30', 'linh', 'Buổi chia sẻ trực tiếp em đề xuất làm tối thứ Tư, ngày 21 tháng 10. Lần trước làm trưa thứ Bảy chỉ có 40 người xem. Em cũng muốn xin hai học viên cũ lên nói mười phút mỗi người, vì bài đăng có câu chuyện thật luôn được chia sẻ nhiều gấp ba bài thường.'),
    P('31:55', 's3', 'Về ngân sách quảng cáo, đợt trước mình chi sáu triệu và mỗi lượt đăng ký tốn khoảng bảy mươi nghìn. Em nghĩ đợt này giữ sáu triệu thôi, nhưng dồn vào tuần ba và tuần bốn thay vì rải đều. Còn có nên giảm giá cho người đăng ký sớm không thì em chưa chắc.'),
    P('34:40', 'son', 'Vấn đề giảm giá mình để ngỏ, tuần sau có số liệu buổi chia sẻ rồi quyết. Giờ mình phân công. Linh viết lại trang đăng ký, tập trung vào kết quả đầu ra, xong trước thứ Sáu tuần này. Linh cũng liên hệ hai học viên cũ cho buổi chia sẻ.'),
    P('37:25', 'son', 'Phần tài liệu cài đặt gộp thành một bản, mình nhận, hạn là ngày 25 tháng 10. Lịch sáu buổi và buổi hỏi đáp Chủ nhật thì bạn phụ trách kỹ thuật cập nhật lên trang khoá học trong tuần này. Kế hoạch quảng cáo dồn vào hai tuần cuối cũng do bạn lên chi tiết.'),
    P('40:10', 'linh', 'Em bổ sung một việc: em sẽ nhắn lại cho 22 người đã đăng ký mà chưa chuyển khoản, sau khi trang đăng ký mới xong. Và em đề nghị mình họp lại vào thứ Năm tuần sau, 15 phút thôi, để xem số liệu.'),
    P('41:30', 'son', 'Đồng ý, thứ Năm tuần sau, 15 phút. Cảm ơn mọi người, mình kết thúc ở đây.')
  ]

  const PARAGRAPHS = blocks.map((b, i) => {
    const startMs = ms(b.time)
    const total = SESSION.startClock[0] * 60 + SESSION.startClock[1] + Math.floor(startMs / 60000)
    const pad = (n) => String(n).padStart(2, '0')
    return { id: 'p' + (i + 1), startMs, clock: `${pad(Math.floor(total / 60))}:${pad(total % 60)}`, speaker: b.speaker, text: b.text }
  })

  const TOPICS = [
    { title: 'Mở đầu và mục tiêu buổi họp', from: 1, to: 2, hue: 262 },
    { title: 'Kết quả đợt mở bán thử', from: 3, to: 5, hue: 205 },
    { title: 'Nội dung và lịch học khoá tháng 11', from: 6, to: 9, hue: 172 },
    { title: 'Kế hoạch truyền thông bốn tuần', from: 10, to: 12, hue: 300 },
    { title: 'Phân công và mốc thời gian', from: 13, to: 16, hue: 28 }
  ]

  // `at` = the paragraph (1-based) where the action is stated; clicking the action jumps there.
  const ACTIONS = [
    { text: 'Viết lại trang đăng ký, tập trung vào kết quả đầu ra', owner: 'Linh', due: 'thứ Sáu tuần này', at: 13 },
    { text: 'Liên hệ hai học viên cũ cho buổi chia sẻ trực tiếp', owner: 'Linh', due: 'trước 21/10', at: 11 },
    { text: 'Gộp ba bản tài liệu cài đặt thành một bản', owner: 'Sơn', due: '25/10', at: 8 },
    { text: 'Cập nhật lịch sáu buổi và buổi hỏi đáp Chủ nhật lên trang khoá học', owner: 'Người nói 3', due: 'trong tuần này', at: 14 },
    { text: 'Lên chi tiết kế hoạch quảng cáo, dồn ngân sách vào tuần ba và tuần bốn', owner: 'Người nói 3', due: null, at: 12 },
    { text: 'Nhắn lại 22 người đã đăng ký mà chưa chuyển khoản', owner: 'Linh', due: 'sau khi có trang mới', at: 15 },
    { text: 'Quyết định có giảm giá cho người đăng ký sớm hay không', owner: null, due: 'tuần sau', at: 13 },
    { text: 'Họp lại 15 phút để xem số liệu', owner: 'Cả nhóm', due: 'thứ Năm tuần sau', at: 16 }
  ]

  window.SAMPLE = { SESSION, SPEAKERS, PARAGRAPHS, TOPICS, ACTIONS }
})()

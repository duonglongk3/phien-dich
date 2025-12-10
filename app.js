// Kiểm tra hỗ trợ Web Speech API
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
    alert('Trình duyệt không hỗ trợ Web Speech API. Vui lòng sử dụng Chrome hoặc Edge.');
}

// Khởi tạo Speech Recognition với cấu hình tối ưu
const recognition = new SpeechRecognition();
recognition.continuous = false;
recognition.interimResults = true;
recognition.maxAlternatives = 3; // Tăng độ chính xác

// Elements - Manual mode
const btnVietnamese = document.getElementById('btnVietnamese');
const btnChinese = document.getElementById('btnChinese');
const sourceText = document.getElementById('sourceText');
const targetText = document.getElementById('targetText');
const speakBtn = document.getElementById('speakBtn');
const status = document.getElementById('status');

// Elements - Auto mode
const autoViToZh = document.getElementById('autoViToZh');
const autoZhToVi = document.getElementById('autoZhToVi');

// Biến lưu trạng thái
let currentMode = null; // 'vi-to-zh' hoặc 'zh-to-vi'
let isRecording = false;
let autoMode = null; // null, 'vi-to-zh', hoặc 'zh-to-vi', hoặc 'auto-detect'
let isTranslating = false;
let isSpeaking = false;

// Lưu bản dịch cuối cùng để tránh loop (mic ghi lại tiếng từ loa)
let lastTranslation = '';
let lastSourceText = '';
let clearEchoTimeout = null;



// Hàm reset echo protection sau 10 giây
function resetEchoProtection() {
    if (clearEchoTimeout) clearTimeout(clearEchoTimeout);
    clearEchoTimeout = setTimeout(() => {
        lastTranslation = '';
        lastSourceText = '';
    }, 10000);
}



// Hàm cập nhật trạng thái
function updateStatus(message, type = '') {
    status.textContent = message;
    status.className = 'status ' + type;
}

// Hàm cập nhật UI nút auto mode
function updateAutoButtonUI() {
    const viStatus = autoViToZh.querySelector('.mode-status');
    const zhStatus = autoZhToVi.querySelector('.mode-status');
    
    // Reset tất cả
    autoViToZh.classList.remove('active', 'listening');
    autoZhToVi.classList.remove('active', 'listening');
    viStatus.textContent = 'TẮT';
    zhStatus.textContent = 'TẮT';
    
    if (autoMode === 'vi-to-zh') {
        autoViToZh.classList.add('active');
        viStatus.textContent = 'BẬT';
    } else if (autoMode === 'zh-to-vi') {
        autoZhToVi.classList.add('active');
        zhStatus.textContent = 'BẬT';
    }
}

// Hàm lấy pinyin cho text tiếng Trung
async function getPinyin(chineseText) {
    try {
        // Dịch từ zh-CN sang zh-CN với dt=rm để lấy pinyin
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=zh-CN&dt=rm&q=${encodeURIComponent(chineseText)}`;
        const response = await fetch(url);
        const data = await response.json();
        
        let pinyin = '';
        // Pinyin nằm ở data[0][i][3] khi source là tiếng Trung
        if (data && data[0]) {
            data[0].forEach(item => {
                if (item && item[3]) {
                    pinyin += item[3] + ' ';
                }
            });
        }
        return pinyin.trim();
    } catch (error) {
        console.error('Lỗi lấy pinyin:', error);
        return '';
    }
}

// Hàm dịch văn bản sử dụng Google Translate API (miễn phí)
// Trả về object { text, pinyin } nếu dịch sang tiếng Trung
async function translateText(text, sourceLang, targetLang) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        let translatedText = '';
        
        // Lấy bản dịch
        if (data && data[0]) {
            data[0].forEach(item => {
                if (item[0]) {
                    translatedText += item[0];
                }
            });
        }
        
        // Nếu dịch sang tiếng Trung, lấy thêm pinyin
        let pinyin = '';
        if (targetLang === 'zh-CN' && translatedText) {
            pinyin = await getPinyin(translatedText);
        }
        
        return { text: translatedText, pinyin: pinyin };
    } catch (error) {
        console.error('Lỗi dịch:', error);
        throw new Error('Không thể dịch văn bản');
    }
}

// Cache audio để phát nhanh hơn
let preloadedAudio = null;

// Hàm tạo URL TTS
function getTTSUrl(text, lang) {
    let ttsLang = lang;
    if (lang === 'vi-VN') ttsLang = 'vi';
    if (lang === 'zh-CN') ttsLang = 'zh-CN';
    return `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${ttsLang}&client=tw-ob`;
}

// Hàm preload audio (gọi ngay khi có kết quả dịch)
function preloadAudio(text, lang) {
    const url = getTTSUrl(text, lang);
    preloadedAudio = new Audio(url);
    preloadedAudio.preload = 'auto';
    preloadedAudio.load();
}

// Hàm phát âm văn bản sử dụng Google Translate TTS
function speakText(text, lang, callback) {
    // KHÔNG set isSpeaking ở đây - đã được set trước khi gọi hàm này
    
    // Chuyển đổi lang code cho Google TTS
    let ttsLang = lang;
    if (lang === 'vi-VN') ttsLang = 'vi';
    if (lang === 'zh-CN') ttsLang = 'zh-CN';
    
    // Chia nhỏ text nếu quá dài (Google TTS giới hạn ~200 ký tự)
    const maxLen = 200;
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }
        let splitIndex = remaining.lastIndexOf(' ', maxLen);
        if (splitIndex === -1 || splitIndex < maxLen / 2) {
            splitIndex = remaining.lastIndexOf(',', maxLen);
        }
        if (splitIndex === -1 || splitIndex < maxLen / 2) {
            splitIndex = maxLen;
        }
        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trim();
    }
    
    let currentChunk = 0;
    
    function playNextChunk() {
        if (currentChunk >= chunks.length) {
            // KHÔNG set isSpeaking = false ở đây - để callback quản lý
            preloadedAudio = null;
            if (callback) callback();
            return;
        }
        
        const chunk = chunks[currentChunk];
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${ttsLang}&client=tw-ob`;
        
        // Dùng audio đã preload nếu là chunk đầu tiên và text khớp
        let audio;
        if (currentChunk === 0 && preloadedAudio && chunks.length === 1) {
            audio = preloadedAudio;
        } else {
            audio = new Audio(url);
        }
        
        audio.onended = () => {
            currentChunk++;
            playNextChunk();
        };
        audio.onerror = () => {
            fallbackSpeak(text, lang, callback);
        };
        audio.play().catch(() => {
            fallbackSpeak(text, lang, callback);
        });
    }
    
    playNextChunk();
}

// Fallback sử dụng Web Speech API
function fallbackSpeak(text, lang, callback) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.9;
    utterance.pitch = 1;
    
    utterance.onend = () => {
        // KHÔNG set isSpeaking = false ở đây - để callback quản lý
        if (callback) callback();
    };
    
    utterance.onerror = () => {
        // KHÔNG set isSpeaking = false ở đây - để callback quản lý
        if (callback) callback();
    };
    
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
}

// Hàm bắt đầu chế độ tự động
function startAutoMode(mode) {
    if (autoMode === mode) {
        stopAutoMode();
        return;
    }
    
    stopAutoMode();
    autoMode = mode;
    if (mode !== 'auto-detect') {
        currentMode = mode;
    }
    updateAutoButtonUI();
    
    if (mode === 'vi-to-zh') {
        updateStatus('🎤 Sẵn sàng nghe tiếng Việt...', 'listening');
    } else if (mode === 'zh-to-vi') {
        updateStatus('🎤 Sẵn sàng nghe tiếng Trung...', 'listening');
    }
    
    startAutoListening();
}

// Hàm dừng chế độ tự động
function stopAutoMode() {
    autoMode = null;
    updateAutoButtonUI();
    
    if (isRecording) {
        recognition.stop();
    }
    
    window.speechSynthesis.cancel();
    isSpeaking = false;
    isTranslating = false;
    
    autoViToZh.classList.remove('listening');
    autoZhToVi.classList.remove('listening');
    
    updateStatus('', '');
}



// Hàm bắt đầu nghe trong chế độ tự động
function startAutoListening() {
    // Kiểm tra tất cả điều kiện - KHÔNG ghi âm nếu đang phát âm hoặc đang dịch
    if (!autoMode || isRecording || isTranslating || isSpeaking) {
        console.log('Blocked: autoMode=' + autoMode + ', isRecording=' + isRecording + ', isTranslating=' + isTranslating + ', isSpeaking=' + isSpeaking);
        return;
    }
    
    isRecording = true;
    
    if (autoMode === 'vi-to-zh') {
        currentMode = 'vi-to-zh';
        recognition.lang = 'vi-VN';
        autoViToZh.classList.add('listening');
        updateStatus('🎤 Đang nghe tiếng Việt...', 'listening');
    } else if (autoMode === 'zh-to-vi') {
        currentMode = 'zh-to-vi';
        recognition.lang = 'zh-CN';
        autoZhToVi.classList.add('listening');
        updateStatus('🎤 Đang nghe tiếng Trung...', 'listening');
    }
    
    try {
        recognition.start();
    } catch (e) {
        console.log('Recognition already started');
    }
}

// Hàm bắt đầu ghi âm thủ công
function startManualRecording(mode) {
    if (isRecording) return;
    
    if (autoMode) {
        stopAutoMode();
    }
    
    currentMode = mode;
    isRecording = true;
    
    if (mode === 'vi-to-zh') {
        recognition.lang = 'vi-VN';
        btnVietnamese.classList.add('recording');
        updateStatus('🎤 Đang nghe tiếng Việt...', 'listening');
    } else {
        recognition.lang = 'zh-CN';
        btnChinese.classList.add('recording');
        updateStatus('🎤 Đang nghe tiếng Trung...', 'listening');
    }
    
    recognition.start();
}

// Hàm chuẩn hóa text để so sánh
function normalizeText(str) {
    return str.toLowerCase().replace(/[.,!?，。！？\s]/g, '');
}

// Hàm tính độ tương đồng
function calculateSimilarity(text1, text2) {
    const norm1 = normalizeText(text1);
    const norm2 = normalizeText(text2);
    
    if (norm1 === norm2) return 1;
    if (norm1.length === 0 || norm2.length === 0) return 0;
    
    // Kiểm tra substring
    if (norm2.includes(norm1) && norm1.length > 2) return 0.9;
    if (norm1.includes(norm2) && norm2.length > 2) return 0.9;
    
    // Tính độ tương đồng dựa trên ký tự chung
    const maxLen = Math.max(norm1.length, norm2.length);
    let matches = 0;
    const shorter = norm1.length < norm2.length ? norm1 : norm2;
    const longer = norm1.length < norm2.length ? norm2 : norm1;
    
    for (let i = 0; i < shorter.length; i++) {
        if (longer.includes(shorter[i])) matches++;
    }
    
    return matches / maxLen;
}

// Hàm kiểm tra text có giống bản dịch vừa phát không (để tránh loop)
function isSimilarToLastTranslation(text) {
    if (!lastTranslation) return false;
    return calculateSimilarity(text, lastTranslation) > 0.6; // 60% bỏ qua
}

// Hàm kiểm tra text có giống nguồn vừa nói không
function isSimilarToLastSource(text) {
    if (!lastSourceText) return false;
    return calculateSimilarity(text, lastSourceText) > 0.6; // 60% bỏ qua
}

// Hàm phát hiện ngôn ngữ dựa trên ký tự
function detectLanguage(text) {
    // Đếm ký tự Trung Quốc (CJK Unified Ideographs)
    const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
    // Đếm ký tự tiếng Việt (có dấu)
    const vietnameseChars = text.match(/[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/gi) || [];
    
    const totalChars = text.replace(/\s/g, '').length;
    if (totalChars === 0) return null;
    
    const chineseRatio = chineseChars.length / totalChars;
    const vietnameseRatio = vietnameseChars.length / totalChars;
    
    console.log('Detect lang:', {text, chineseRatio, vietnameseRatio, chineseChars: chineseChars.length, vietnameseChars: vietnameseChars.length});
    
    // Tiếng Trung: có nhiều ký tự Hán
    if (chineseRatio > 0.5) return 'zh-CN';
    
    // Tiếng Việt: có dấu tiếng Việt
    if (vietnameseRatio > 0.05) return 'vi';
    
    // Nếu không rõ ràng, dựa trên ngôn ngữ đang nghe
    return autoDetectTryLang === 'vi-VN' ? 'vi' : 'zh-CN';
}

// Xử lý kết quả nhận dạng giọng nói
recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript;
    sourceText.textContent = transcript;
    sourceText.classList.remove('has-placeholder');
    
    if (event.results[0].isFinal) {
        // Dừng ghi âm ngay lập tức khi có kết quả cuối cùng
        isRecording = false;
        try { recognition.stop(); } catch(e) {}
        
        // QUAN TRỌNG: Kiểm tra xem có phải echo từ loa không
        if (autoMode && (isSimilarToLastTranslation(transcript) || isSimilarToLastSource(transcript))) {
            console.log('Bỏ qua echo:', transcript);
            updateStatus('🔇 Bỏ qua tiếng vọng...', 'listening');
            // Đợi 1 giây rồi nghe tiếp
            setTimeout(() => {
                if (autoMode) {
                    startAutoListening();
                }
            }, 1000);
            return;
        }
        
        isTranslating = true;
        updateStatus('🔄 Đang dịch...', 'translating');
        
        try {
            let translated;
            let targetLang;
            let sourceLang;
            
            // Xác định ngôn ngữ nguồn và đích
            if (currentMode === 'vi-to-zh') {
                sourceLang = 'vi';
                targetLang = 'zh-CN';
            } else {
                sourceLang = 'zh-CN';
                targetLang = 'vi-VN';
            }
            
            const result = await translateText(transcript, sourceLang, targetLang);
            translated = result.text;
            
            // Lưu lại để tránh loop echo
            lastTranslation = translated;
            lastSourceText = transcript;
            resetEchoProtection(); // Tự động reset sau 10 giây
            
            // Hiển thị bản dịch và pinyin (nếu có)
            if (result.pinyin && targetLang === 'zh-CN') {
                targetText.innerHTML = `<span class="translation-text">${translated}</span><span class="pinyin-text">${result.pinyin}</span>`;
            } else {
                targetText.textContent = translated;
            }
            targetText.classList.remove('has-placeholder');
            
            // QUAN TRỌNG: Set isSpeaking = true TRƯỚC khi phát âm để block mọi ghi âm mới
            isSpeaking = true;
            updateStatus('🔊 Đang phát âm...', 'speaking');
            
            // Preload và phát âm ngay lập tức
            preloadAudio(translated, targetLang);
            speakText(translated, targetLang, () => {
                // Delay 800ms sau khi phát xong để tránh ghi âm tiếng vọng từ loa
                setTimeout(() => {
                    isSpeaking = false;
                    isTranslating = false;
                    // Nếu đang ở chế độ tự động, tiếp tục nghe
                    if (autoMode) {
                        if (autoMode === 'vi-to-zh') {
                            updateStatus('🎤 Sẵn sàng nghe tiếng Việt...', 'listening');
                        } else if (autoMode === 'zh-to-vi') {
                            updateStatus('🎤 Sẵn sàng nghe tiếng Trung...', 'listening');
                        } else if (autoMode === 'auto-detect') {
                            updateStatus('🎤 Sẵn sàng nghe (tự động phát hiện)...', 'listening');
                        }
                        startAutoListening();
                    }
                }, 800);
            });
            
        } catch (error) {
            isTranslating = false;
            updateStatus('❌ Lỗi: ' + error.message, 'error');
            
            // Nếu lỗi mà đang ở auto mode, thử lại ngay
            if (autoMode) {
                setTimeout(() => startAutoListening(), 500);
            }
        }
    }
};

// Xử lý khi kết thúc ghi âm
recognition.onend = () => {
    isRecording = false;
    btnVietnamese.classList.remove('recording');
    btnChinese.classList.remove('recording');
    autoViToZh.classList.remove('listening');
    autoZhToVi.classList.remove('listening');
    
    // Nếu đang ở chế độ tự động và không đang dịch/phát âm, tiếp tục nghe ngay
    if (autoMode && !isTranslating && !isSpeaking) {
        startAutoListening();
    }
};

// Xử lý lỗi
recognition.onerror = (event) => {
    isRecording = false;
    btnVietnamese.classList.remove('recording');
    btnChinese.classList.remove('recording');
    autoViToZh.classList.remove('listening');
    autoZhToVi.classList.remove('listening');
    
    let errorMsg = 'Lỗi nhận dạng giọng nói';
    let shouldRetry = false;
    
    if (event.error === 'no-speech') {
        // Không có giọng nói - trong auto mode, tiếp tục nghe
        if (autoMode) {
            shouldRetry = true;
            if (autoMode === 'vi-to-zh') {
                updateStatus('🎤 Đang chờ tiếng Việt...', 'listening');
            } else if (autoMode === 'zh-to-vi') {
                updateStatus('🎤 Đang chờ tiếng Trung...', 'listening');
            }
        } else {
            errorMsg = 'Không nghe thấy giọng nói. Vui lòng thử lại.';
        }
    } else if (event.error === 'not-allowed') {
        errorMsg = 'Vui lòng cho phép truy cập microphone.';
        stopAutoMode();
    } else if (event.error === 'aborted') {
        // Bị hủy - có thể do người dùng tắt auto mode
        return;
    }
    
    if (!shouldRetry) {
        updateStatus('❌ ' + errorMsg, 'error');
    }
    
    // Retry trong auto mode ngay lập tức
    if (autoMode && shouldRetry) {
        startAutoListening();
    }
};

// Event listeners cho các nút thủ công
btnVietnamese.addEventListener('click', () => startManualRecording('vi-to-zh'));
btnChinese.addEventListener('click', () => startManualRecording('zh-to-vi'));

// Event listeners cho các nút tự động
autoViToZh.addEventListener('click', () => startAutoMode('vi-to-zh'));
autoZhToVi.addEventListener('click', () => startAutoMode('zh-to-vi'));

// Nút phát âm lại
speakBtn.addEventListener('click', () => {
    const text = targetText.textContent;
    if (text && !targetText.classList.contains('has-placeholder') && currentMode && !isSpeaking) {
        const lang = currentMode === 'vi-to-zh' ? 'zh-CN' : 'vi-VN';
        isSpeaking = true;
        speakText(text, lang, () => {
            isSpeaking = false;
        });
    }
});

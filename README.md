# LLM Triple View

ChatGPT · Gemini · Claude 를 Chrome 창 3분할로 띄우고, 하단 통합 입력창에서 한 번에 프롬프트를 보내는 Windows 데스크톱 앱입니다.

## 실행
```
npm install
npm start
```
처음 한 번 각 사이트에 로그인하면 전용 Chrome 프로필(`%LOCALAPPDATA%\llm-triple-chrome-profile`)에 유지됩니다.

## 기능
- 3분할 자동 배치 / **3분할 복귀** 버튼
- **모니터 이동** 버튼 (멀티 모니터)
- 전송 대상 선택, 새 대화

## 설치 파일 빌드
```
npm run dist
```
`dist/` 에 설치 파일이 생성됩니다. (경로/권한 문제 시 영문 경로 `C:` 드라이브에서 빌드)

#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

## user_problem_statement: "Fix uploaded AIToolsNova static website SEO/indexing/canonical/link errors, Cloudflare/Bing/Search Console/AdSense integration claims, broken AI tools including background remover, and autoblogger uniqueness/simple English/affiliate-image workflow."
## backend:
##   - task: "FastAPI health and Gemini endpoint"
##     implemented: true
##     working: true
##     file: "backend/server.py"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Health endpoint returns 200 after restoring uploaded source; Gemini endpoint is guarded by environment key."
## frontend:
##   - task: "Static pages, metadata, canonical, robots and sitemap"
##     implemented: true
##     working: true
##     file: "index.html, robots.txt, sitemap.xml"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Removed missing sitemap URLs, fixed one broken blog link, added missing production canonicals/robots metadata, and removed unsupported Host directive."
##   - task: "Background remover and core tool UI"
##     implemented: true
##     working: true
##     file: "tools/background-remover.html"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Replaced unreliable UMD global loader with dynamic ESM import for @imgly/background-removal and honest error state. Browser page loads successfully."
##   - task: "AutoBlog uniqueness and affiliate support"
##     implemented: true
##     working: true
##     file: "scripts/generate-blog.mjs"
##     stuck_count: 0
##     priority: "medium"
##     needs_retesting: true
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Existing history/slug safeguards retained; optional affiliate product name, URL and disclosure are now rendered as sponsored nofollow links when configured."
## metadata:
##   created_by: "main_agent"
##   version: "2.0"
##   test_sequence: 1
##   run_ui: true
## test_plan:
##   current_focus:
##     - "production static route and internal-link integrity"
##     - "canonical, robots and sitemap validation"
##     - "background remover loader and upload controls"
##     - "Gemini API request/error shape"
##     - "autoblogger duplicate and affiliate output safeguards"
##   stuck_tasks: []
##   test_all: true
##   test_priority: "high_first"
## agent_communication:
##   - agent: "main"
##     message: "Uploaded ZIP restored into /app and targeted SEO, sitemap, canonical, AI loader and autoblogger fixes applied. Please test the actual static site, not the old React starter."
##   - agent: "testing"
##     message: "39/40 passed; valid Gemini request failed only because EMERGENT_LLM_KEY was absent. Main configured the existing server key, restarted backend, and verified /api/gemini HTTP 200 plus homepage AI draft output."
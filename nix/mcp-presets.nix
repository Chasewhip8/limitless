{
  # Keep read exceptions exact so new tools cannot silently gain research access.
  # Catalogs audited against first-party documentation and live discovery on 2026-09-23.
  atlassian = {
    settings = {
      type = "remote";
      url = "https://mcp.atlassian.com/v2/mcp?tools=all";
    };
    # https://support.atlassian.com/atlassian-ai-gateway/docs/supported-tools/
    readTools = [
      "atlassianUserInfo"
      "getAccessibleAtlassianResources"

      "getJiraIssue"
      "listJiraIssueComments"
      "searchJiraIssuesUsingJql"
      "listJiraProjects"
      "listJiraProjectIssueTypesMetadata"
      "getJiraIssueTypeMetaWithFields"
      "listJiraIssueTransitions"
      "listJiraIssueLinkTypes"
      "listJiraIssueRemoteIssueLinks"
      "listJiraIssueWorklogs"
      "lookupJiraAccountId"
      "listJiraIssueAssignableUsers"
      "listJiraIssueChangelogs"
      "getJiraCurrentUser"
      "getJiraUser"
      "listJiraStatuses"
      "listJiraProjectComponents"
      "getJiraProjectVersions"
      "getJiraProjectVersionRelatedWork"
      "listJiraBoards"
      "getJiraBoardConfig"
      "getJiraBoardIssueData"
      "getJiraBoardSprintData"
      "listJiraBoardSprints"
      "listJiraFilters"
      "listJiraDashboards"
      "getJiraEntityProperty"
      "downloadJiraIssueAttachment"

      "getConfluenceContent"
      "listConfluenceComments"
      "searchConfluence"
      "listConfluenceContent"
      "listConfluenceSpaces"
      "getConfluenceSpace"
      "getConfluenceSpaceInstructions"
      "getConfluencePersonalSpace"
      "getConfluenceComment"
      "listConfluenceContentVersions"
      "getConfluenceContentVersion"
      "diffConfluenceContentVersions"
      "listConfluenceAttachments"
      "getConfluenceAttachment"
      "downloadConfluenceAttachment"
      "getConfluenceContentPermissions"
      "getConfluenceContentRestrictionState"
      "getConfluencePublicLinkStatus"
      "getConfluenceReactions"
      "getConfluenceTask"
      "listConfluenceTasks"
      "listConfluenceTemplates"
      "getConfluenceTemplate"
      "resolveConfluenceContentMacros"

      "getJsmOpsAlerts"
      "getJsmOpsScheduleInfo"
      "getJsmOpsTeamInfo"

      "listBitbucketWorkspaces"
      "getBitbucketWorkspace"
      "listBitbucketRepositories"
      "getBitbucketRepository"
      "getBitbucketRepoDefaultReviewers"
      "getBitbucketRepoFileContent"
      "getBitbucketRepoBranch"
      "getBitbucketRepoCommit"
      "listBitbucketRepoCommitReports"
      "getBitbucketRepoCommitReport"
      "getBitbucketRepoCommitReportAnnotations"
      "listBitbucketRepoPullRequests"
      "getBitbucketRepoPullRequest"
      "getBitbucketRepoPullRequestDiff"
      "listBitbucketRepoPullRequestComments"
      "listBitbucketRepoPullRequestTasks"
      "listBitbucketRepoPipelines"
      "getBitbucketRepoPipeline"
      "listBitbucketRepoPipelineSteps"
      "getBitbucketRepoPipelineStep"
      "getBitbucketRepoPipelineStepLog"
      "listBitbucketRepoDeployments"
      "getBitbucketRepoDeployment"
      "listBitbucketRepoEnvironments"
      "getBitbucketRepoEnvironment"

      "getTeamworkGraphContext"
      "getTeamworkGraphObject"
      "search"
      "searchCode"
      "getCodeFile"
      "listCodeDirectory"
      "scanCodeRepo"
      "getCodeSymbol"
      "diffCodeSymbols"

      "getLoomVideo"
      "listLoomVideos"
      "listLoomVideosSharedWithMe"
      "getLoomVideoComments"
      "getLoomMeetingActionItems"
      "getLoomVideoDownloadUrl"
      "listLoomFolders"

      "searchGoals"
      "getGoal"
      "getGoalUpdate"
      "getGoalTypes"
      "searchProjects"
      "getProject"
      "getProjectUpdate"
      "searchTeams"
      "getTeam"
      "searchFocusAreas"
      "getFocusArea"
      "getFocusAreaTypes"
      "getTalentUser"
      "getTalentFields"
      "searchTalentPositions"
      "getTalentPosition"
      "getTalentPositionsByEntity"
      "getTalentGroupMetrics"
    ];
  };
  notion = {
    settings = {
      type = "remote";
      url = "https://mcp.notion.com/mcp";
    };
    # https://developers.notion.com/guides/mcp/mcp-supported-tools
    readTools = [
      "notion-get-tool-access"
      "notion-search"
      "notion-ai-search"
      "notion-fetch"
      "notion-query-data-sources"
      "notion-query-meeting-notes"
      "notion-get-comments"
      "notion-get-teams"
      "notion-get-users"
      "notion-search-skills"
      "notion-download-skill"
      "notion-download-attachment"
      "notion-get-async-task"
      "notion-list-private-pages"
      "notion-list-shared-pages"
      "notion-list-favorite-pages"
      "notion-list-recent-pages"
      "notion-search-agents"
      "notion-search-sessions"
      "notion-query-sessions"
      "notion-get-session-status"
      "notion-wait-session"
      "notion-list-session-events"
      "notion-read-session-event"
    ];
  };
  sentry = {
    settings = {
      type = "remote";
      url = "https://mcp.sentry.dev/mcp";
    };
    readTools = [
      "find_organizations"
      "find_projects"
      "search_events"
      "search_issues"
      "get_sentry_resource"
      "search_sentry_tools"
    ];
  };
  linear = {
    settings = {
      type = "remote";
      url = "https://mcp.linear.app/mcp";
    };
    # Linear does not publish a canonical tool list. Add verified names after sign-in.
    readTools = [ ];
  };
  github = {
    settings = {
      type = "remote";
      url = "https://api.githubcopilot.com/mcp/";
      headers.X-MCP-Toolsets = "context,repos,issues,pull_requests,actions";
    };
    # github/github-mcp-server at 85598ba6e1256f7ebf4867b95d63b833c4549264:
    # ReadOnlyHint registrations; hosted availability depends on enabled toolsets.
    readTools = [
      "get_me"
      "get_teams"
      "get_team_members"
      "get_file_contents"
      "get_repository_tree"
      "get_file_blame"
      "list_branches"
      "list_commits"
      "get_commit"
      "search_code"
      "search_commits"
      "search_repositories"
      "list_tags"
      "get_tag"
      "list_releases"
      "get_latest_release"
      "get_release_by_tag"
      "list_starred_repositories"
      "list_repository_collaborators"
      "issue_read"
      "search_issues"
      "list_issues"
      "list_issue_types"
      "list_issue_fields"
      "issue_dependency_read"
      "find_duplicate"
      "list_pull_requests"
      "pull_request_read"
      "search_pull_requests"
      "actions_get"
      "actions_list"
      "get_job_logs"
    ];
  };
}

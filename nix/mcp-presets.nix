{
  # Keep read exceptions exact: new tools and multiplexed executors require approval.
  # Catalogs audited against first-party documentation on 2026-09-22.
  atlassian = {
    settings = {
      type = "remote";
      url = "https://mcp.atlassian.com/v2/mcp?tools=all";
    };
    readTools = [
      "atlassianUserInfo"
      "getAccessibleAtlassianResources"
      "getJiraIssue"
      "listJiraIssueComments"
      "searchJiraIssuesUsingJql"
      "getConfluenceContent"
      "listConfluenceComments"
      "searchConfluence"
    ];
  };
  notion = {
    settings = {
      type = "remote";
      url = "https://mcp.notion.com/mcp";
    };
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
    readTools = [
      "get_me"
      "get_file_contents"
      "get_repository_tree"
      "list_branches"
      "list_commits"
      "get_commit"
      "search_code"
      "search_repositories"
      "issue_read"
      "search_issues"
      "list_pull_requests"
      "pull_request_read"
      "search_pull_requests"
      "actions_get"
      "actions_list"
      "get_job_logs"
    ];
  };
}
